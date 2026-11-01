import assert from 'node:assert/strict';
import { ClaudeError, costMicros, type Claude, type Usage } from '../src/chat/anthropic.ts';

export type Ev = { type: string; [k: string]: unknown };
export const start = (): Ev => ({ type: 'message_start', message: { usage: { input_tokens: 1000 } } });
export const text = (i: number, ...parts: string[]): Ev[] => [
  { type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } },
  ...parts.map((p) => ({ type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: p } })),
  { type: 'content_block_stop', index: i },
];
export const tool = (i: number, id: string, name: string, input: unknown): Ev[] => [
  { type: 'content_block_start', index: i, content_block: { type: 'tool_use', id, name, input: {} } },
  { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } },
  { type: 'content_block_stop', index: i },
];
export const thinking = (i: number, thought: string, signature: string): Ev[] => [
  { type: 'content_block_start', index: i, content_block: { type: 'thinking', thinking: '' } },
  { type: 'content_block_delta', index: i, delta: { type: 'thinking_delta', thinking: thought } },
  { type: 'content_block_delta', index: i, delta: { type: 'signature_delta', signature } },
  { type: 'content_block_stop', index: i },
];
export const end = (stop: string): Ev[] => [{ type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: 50 } }, { type: 'message_stop' }];
type Message = { role: string; content: string | { type: string; id?: string; tool_use_id?: string; text?: string }[] };

/** The request rules the Messages API enforces on history: starts with user, roles alternate, tool_use and tool_result pair up. */
export function assertValid(messages: Message[]): void {
  assert.equal(messages[0]?.role, 'user');
  const ids = (m: Message | undefined, type: string, key: 'id' | 'tool_use_id') =>
    (Array.isArray(m?.content) ? m.content : []).filter((b) => b.type === type).map((b) => b[key]);
  messages.forEach((m, i) => {
    if (Array.isArray(m.content)) {
      assert.ok(m.content.length, `message ${i} has content`);
      assert.ok(m.content.every((b) => b.type !== 'text' || b.text), `message ${i} has no empty text block`);
    }
    if (i) assert.notEqual(m.role, messages[i - 1]!.role, `roles alternate at ${i}`);
    if (m.role === 'assistant') assert.deepEqual(ids(messages[i + 1], 'tool_result', 'tool_use_id'), ids(m, 'tool_use', 'id'), `tool results answer message ${i}`);
    else assert.deepEqual(ids(m, 'tool_result', 'tool_use_id'), ids(messages[i - 1], 'tool_use', 'id'), `tool results at ${i} have their tool_use`);
  });
}

/** Replays one scripted round of SSE events per stream() call and records each request body. */
export class FakeClaude implements Claude {
  requests: Record<string, unknown>[] = [];
  /** Throws ClaudeError(code) in round `round`: before the response when `event` is undefined, else before that event index. */
  fail?: { round: number; event?: number; code: string };
  /** Every round waits before event index `event` until `until` settles or the call is aborted. */
  hold?: { event: number; until: Promise<unknown> };
  private readonly rounds: Ev[][];
  constructor(rounds: Ev[][]) { this.rounds = rounds; }

  /** The non-streaming reply (the chat title call), or the error it throws; unset replies with no text. */
  reply?: unknown;
  messageRequests: { feature: string; body: Record<string, unknown> }[] = [];
  async messages(feature: string, body: Record<string, unknown>) {
    this.messageRequests.push({ feature, body: structuredClone(body) });
    if (this.reply instanceof Error) throw this.reply;
    return { reply: this.reply ?? { content: [] }, key: 'main' as const };
  }
  async stream(_feature: string, body: Record<string, unknown>, signal?: AbortSignal) {
    const round = this.requests.length;
    this.requests.push(structuredClone(body));
    assertValid(body.messages as Message[]);
    const fail = this.fail?.round === round ? this.fail : undefined;
    if (fail && fail.event === undefined) throw new ClaudeError(fail.code);
    // like fetch with an aborted signal
    if (signal?.aborted) throw new ClaudeError('ABORTED');
    const events = this.rounds[round] ?? [];
    const hold = this.hold;
    async function* gen() {
      for (const [i, e] of events.entries()) {
        if (hold?.event === i) await new Promise((r) => { void hold.until.then(r); signal?.addEventListener('abort', r); });
        if (signal?.aborted) throw new ClaudeError('ABORTED');
        if (fail?.event === i) throw new ClaudeError(fail.code);
        yield e;
      }
    }
    return { events: gen(), key: 'main' as const };
  }
  record(_feature: string, model: string, _key: string, usage: Usage): number { return costMicros(model, usage); }
}
