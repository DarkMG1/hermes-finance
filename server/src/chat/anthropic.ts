import type { Db } from '../db.ts';
import type { Config } from '../config.ts';
import { localDay } from '../networth.ts';

export type Feature = 'chat' | 'receipt';
export type Usage = { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
type Key = 'main' | 'backup';
type Event = { type: string; [k: string]: unknown };
export class ClaudeError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = 'ClaudeError'; this.code = code; }
}
export type Claude = {
  /** Non-streaming Messages call. Returns the parsed JSON reply. Records usage. */
  messages(feature: Feature, body: Record<string, unknown>, signal?: AbortSignal): Promise<{ reply: unknown; key: Key }>;
  /** Streaming Messages call: resolves once the HTTP response is OK (after any key fallback), then yields parsed SSE events. */
  stream(feature: Feature, body: Record<string, unknown>, signal?: AbortSignal): Promise<{ events: AsyncIterable<Event>; key: Key }>;
  /** Records usage for a streamed call once its totals are known. */
  record(feature: Feature, model: string, key: Key, usage: Usage): void;
  usage(): { month: string; costCents: number; backupActive: boolean };
};

// USD cents per million tokens. Verify against anthropic.com/pricing when models change.
const PRICES: Record<string, { in: number; out: number }> = {
  'claude-opus-5-5': { in: 500, out: 2500 },
  'claude-sonnet-5-5': { in: 300, out: 1500 },
};
export function costCents(model: string, u: Usage): number {
  const p = PRICES[model] ?? PRICES['claude-opus-5-5']!;
  const m = (n?: number) => (n ?? 0) / 1_000_000;
  // cache reads bill at 0.1x input, cache writes at 1.25x input
  return Math.ceil(p.in * (m(u.input_tokens) + 0.1 * m(u.cache_read_input_tokens) + 1.25 * m(u.cache_creation_input_tokens)) + p.out * m(u.output_tokens));
}
const CREDIT = /credit balance is too low/i;

function fail(e: unknown, signal?: AbortSignal): ClaudeError {
  if (e instanceof ClaudeError) return e;
  if (signal?.aborted) return new ClaudeError('ABORTED');
  return new ClaudeError(e instanceof Error && e.name === 'TimeoutError' ? 'TIMEOUT' : 'UNREACHABLE');
}

async function* sse(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<Event> {
  let buf = '';
  const decoder = new TextDecoder();
  try {
    for await (const chunk of body) {
      buf += decoder.decode(chunk, { stream: true });
      let end;
      while ((end = buf.indexOf('\n\n')) >= 0) {
        const data = buf.slice(0, end).split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
        buf = buf.slice(end + 2);
        if (!data) continue;
        let event: Event;
        try { event = JSON.parse(data) as Event; } catch { throw new ClaudeError('INVALID_OUTPUT'); }
        if (event.type === 'error') throw new ClaudeError(`STREAM_${(event.error as { type?: string } | undefined)?.type ?? 'unknown'}`);
        yield event;
      }
    }
  } catch (e) {
    throw fail(e, signal);
  }
}

export function createClaude(deps: { db: Db; config: Config; now: () => Date }, fetchFn: typeof fetch = fetch): Claude | null {
  const { db, config } = deps;
  const mainKey = config.anthropicApiKey;
  if (!mainKey) return null;
  const month = () => localDay(deps.now()).slice(0, 7);
  const backupActive = (m: string) => db.prepare('SELECT backup_active FROM ai_key_state WHERE month = ?').pluck().get(m) === 1;

  // Falls back to the backup key only on the initial HTTP status, before any of the reply is used.
  async function post(feature: Feature, body: Record<string, unknown>, signal?: AbortSignal): Promise<{ res: Response; key: Key }> {
    const m = month();
    let key: Key = backupActive(m) && config.anthropicBackupKey ? 'backup' : 'main';
    const json = JSON.stringify(body);
    for (;;) {
      let res: Response;
      try {
        res = await fetchFn('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'x-api-key': key === 'main' ? mainKey! : config.anthropicBackupKey!, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
          body: json,
          signal: AbortSignal.any([signal, AbortSignal.timeout(feature === 'chat' ? 120_000 : 60_000)].filter((s) => s !== undefined)),
        });
      } catch (e) {
        throw fail(e, signal);
      }
      if (res.ok) return { res, key };
      const text = await res.text().catch((e: unknown) => { throw fail(e, signal); });
      if (res.status !== 400 || !CREDIT.test(text)) throw new ClaudeError(`HTTP_${res.status}`);
      if (key === 'backup') throw new ClaudeError('AI_CREDITS_EXHAUSTED');
      db.prepare('INSERT OR REPLACE INTO ai_key_state (month, backup_active) VALUES (?, 1)').run(m);
      console.log('[hermes] claude main key out of credit: backup key for the rest of the month');
      if (!config.anthropicBackupKey) throw new ClaudeError('AI_CREDITS_EXHAUSTED');
      key = 'backup';
    }
  }

  const claude: Claude = {
    async messages(feature, body, signal) {
      const { res, key } = await post(feature, body, signal);
      let reply: unknown;
      try { reply = await res.json(); } catch (e) { throw e instanceof SyntaxError ? new ClaudeError('INVALID_OUTPUT') : fail(e, signal); }
      if (reply === null || typeof reply !== 'object') throw new ClaudeError('INVALID_OUTPUT');
      claude.record(feature, String(body.model), key, (reply as { usage?: Usage }).usage ?? {});
      return { reply, key };
    },
    async stream(feature, body, signal) {
      const { res, key } = await post(feature, body, signal);
      if (!res.body) throw new ClaudeError('INVALID_OUTPUT');
      return { events: sse(res.body, signal), key };
    },
    record(feature, model, key, u) {
      const cents = costCents(model, u);
      const n = [u.input_tokens ?? 0, u.output_tokens ?? 0, u.cache_read_input_tokens ?? 0, u.cache_creation_input_tokens ?? 0];
      db.prepare(`INSERT INTO ai_usage (at, month, key, feature, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_cents)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(deps.now().toISOString(), month(), key, feature, model, ...n, cents);
      console.log(`[hermes] claude feature=${feature} model=${model} key=${key} in=${n[0]} out=${n[1]} cache=${n[2]}/${n[3]} cents=${cents}`);
    },
    usage() {
      const m = month();
      const costCents = db.prepare('SELECT COALESCE(SUM(cost_cents), 0) FROM ai_usage WHERE month = ?').pluck().get(m) as number;
      return { month: m, costCents, backupActive: backupActive(m) };
    },
  };
  return claude;
}
