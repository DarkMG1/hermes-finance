import type { Db } from '../db.ts';
import type { Config } from '../config.ts';
import { localDay } from '../days.ts';

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
  /** Records usage for a streamed call once its totals are known. Returns its cost in microdollars. */
  record(feature: Feature, model: string, key: Key, usage: Usage): number;
};

// USD per million tokens (= microdollars per token), cache reads as a multiple of input; 5-minute cache writes are 1.25x input.
// From platform.claude.com/docs/en/about-claude/pricing (2026-10-31); verify there when models change.
const PRICES: Record<string, { in: number; out: number; read: number }> = {
  'claude-opus-5-5': { in: 4, out: 20, read: 0.05 },
  'claude-sonnet-5-5': { in: 2, out: 10, read: 0.05 },
  // ponytail: the up-to-100k-token prompt price; Haiku prompts here are chat titles, a few hundred tokens
  'claude-haiku-5-5': { in: 0.1, out: 0.5, read: 0.1 },
};
export function costMicros(model: string, u: Usage): number {
  const p = PRICES[model] ?? PRICES['claude-opus-5-5']!;
  const n = (v?: number) => v ?? 0;
  return Math.round(p.in * (n(u.input_tokens) + p.read * n(u.cache_read_input_tokens) + 1.25 * n(u.cache_creation_input_tokens)) + p.out * n(u.output_tokens));
}
export const toCents = (micros: number): number => Math.round(micros / 10_000);

const backupActive = (db: Db, month: string) => db.prepare('SELECT backup_active FROM ai_key_state WHERE month = ?').pluck().get(month) === 1;

/** This month's spend from the usage rows, whether or not a key is configured. */
export function usage(db: Db, now: Date): { month: string; costCents: number; backupActive: boolean } {
  const month = localDay(now).slice(0, 7);
  const micros = db.prepare('SELECT COALESCE(SUM(cost_microdollars), 0) FROM ai_usage WHERE month = ?').pluck().get(month) as number;
  return { month, costCents: toCents(micros), backupActive: backupActive(db, month) };
}
const CREDIT = /credit balance is too low|reached your specified API usage limits/i;
const TOO_LONG = /prompt is too long|exceeds? (the )?context/i;

function fail(e: unknown, signal?: AbortSignal): ClaudeError {
  if (e instanceof ClaudeError) return e;
  if (signal?.aborted) return new ClaudeError('ABORTED');
  return new ClaudeError(e instanceof Error && e.name === 'TimeoutError' ? 'TIMEOUT' : 'UNREACHABLE');
}

function parseEvent(block: string): Event | null {
  const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
  if (!data) return null;
  let event: Event;
  try { event = JSON.parse(data) as Event; } catch { throw new ClaudeError('INVALID_OUTPUT'); }
  if (event.type === 'error') throw new ClaudeError(`STREAM_${(event.error as { type?: string } | undefined)?.type ?? 'unknown'}`);
  return event;
}

async function* sse(body: ReadableStream<Uint8Array>, timer: Timer, signal?: AbortSignal): AsyncGenerator<Event> {
  let buf = '';
  const decoder = new TextDecoder();
  try {
    for await (const chunk of body) {
      timer.arm();
      // a \r at the end of one chunk pairs with the \n starting the next, so normalize the joined buffer
      buf = (buf + decoder.decode(chunk, { stream: true })).replace(/\r\n/g, '\n');
      const blocks = buf.split('\n\n');
      buf = blocks.pop()!;
      for (const b of blocks) { const e = parseEvent(b); if (e) yield e; }
    }
    const last = parseEvent((buf + decoder.decode()).replace(/\r\n/g, '\n'));
    if (last) yield last;
  } catch (e) {
    throw fail(e, signal);
  } finally {
    timer.disarm();
  }
}

type Timer = { signal: AbortSignal; arm(): void; disarm(): void };
/** Aborts with TimeoutError when not re-armed within ms: covers the wait for headers, then each idle gap of a stream. */
function idleTimer(ms: number): Timer {
  const ctl = new AbortController();
  let t: ReturnType<typeof setTimeout> | undefined;
  const timer = {
    signal: ctl.signal,
    arm() { clearTimeout(t); t = setTimeout(() => ctl.abort(new DOMException('timed out', 'TimeoutError')), ms); },
    disarm() { clearTimeout(t); },
  };
  timer.arm();
  return timer;
}

export function createClaude(deps: { db: Db; config: Config; now: () => Date }, fetchFn: typeof fetch = fetch): Claude | null {
  const { db, config } = deps;
  const mainKey = config.anthropicApiKey;
  if (!mainKey) return null;
  const month = () => localDay(deps.now()).slice(0, 7);

  // Falls back to the backup key only on the initial HTTP status, before any of the reply is used.
  async function post(feature: Feature, body: Record<string, unknown>, signal?: AbortSignal): Promise<{ res: Response; key: Key; timer: Timer }> {
    const m = month();
    let key: Key = backupActive(db, m) && config.anthropicBackupKey ? 'backup' : 'main';
    const json = JSON.stringify(body);
    for (;;) {
      const timer = idleTimer(feature === 'chat' ? 120_000 : 60_000);
      let res: Response;
      try {
        res = await fetchFn('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'x-api-key': key === 'main' ? mainKey! : config.anthropicBackupKey!, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
          body: json,
          signal: signal ? AbortSignal.any([signal, timer.signal]) : timer.signal,
        });
      } catch (e) {
        timer.disarm();
        throw fail(e, signal);
      }
      if (res.ok) return { res, key, timer };
      const text = await res.text().catch((e: unknown) => { throw fail(e, signal); }).finally(() => timer.disarm());
      if (res.status !== 400 || !CREDIT.test(text)) {
        let error: { type?: string; message?: string } | undefined;
        try { error = (JSON.parse(text) as { error?: typeof error }).error; } catch { /* not JSON */ }
        // Anthropic's own error text, never the request: 4xx messages say what was wrong with it
        console.error(`[hermes] claude HTTP ${res.status} type=${error?.type ?? '?'}${res.status < 500 && error?.message ? ` message=${error.message}` : ''}`);
        throw new ClaudeError(res.status === 400 && TOO_LONG.test(text) ? 'CHAT_TOO_LONG' : `HTTP_${res.status}`);
      }
      if (key === 'backup' || !config.anthropicBackupKey) throw new ClaudeError('AI_CREDITS_EXHAUSTED');
      db.prepare('INSERT OR REPLACE INTO ai_key_state (month, backup_active) VALUES (?, 1)').run(m);
      console.log('[hermes] claude main key out of credit: backup key for the rest of the month');
      key = 'backup';
    }
  }

  const claude: Claude = {
    async messages(feature, body, signal) {
      const { res, key, timer } = await post(feature, body, signal);
      let reply: unknown;
      timer.arm();
      try { reply = await res.json(); } catch (e) { throw e instanceof SyntaxError ? new ClaudeError('INVALID_OUTPUT') : fail(e, signal); } finally { timer.disarm(); }
      if (reply === null || typeof reply !== 'object') throw new ClaudeError('INVALID_OUTPUT');
      claude.record(feature, String(body.model), key, (reply as { usage?: Usage }).usage ?? {});
      return { reply, key };
    },
    async stream(feature, body, signal) {
      const { res, key, timer } = await post(feature, body, signal);
      if (!res.body) { timer.disarm(); throw new ClaudeError('INVALID_OUTPUT'); }
      return { events: sse(res.body, timer, signal), key };
    },
    record(feature, model, key, u) {
      const micros = costMicros(model, u);
      const n = [u.input_tokens ?? 0, u.output_tokens ?? 0, u.cache_read_input_tokens ?? 0, u.cache_creation_input_tokens ?? 0];
      db.prepare(`INSERT INTO ai_usage (at, month, key, feature, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_microdollars)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(deps.now().toISOString(), month(), key, feature, model, ...n, micros);
      console.log(`[hermes] claude feature=${feature} model=${model} key=${key} in=${n[0]} out=${n[1]} cache=${n[2]}/${n[3]} micros=${micros}`);
      return micros;
    },
  };
  return claude;
}
