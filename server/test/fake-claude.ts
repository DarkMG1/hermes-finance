import assert from 'node:assert/strict';
import { ClaudeError, type Claude } from '../src/chat/anthropic.ts';

type Event = { type: string; [k: string]: unknown };
type Message = { role: string; content: string | { type: string; id?: string; tool_use_id?: string }[] };

/** The request rules the Messages API enforces on history: starts with user, roles alternate, tool_use and tool_result pair up. */
export function assertValid(messages: Message[]): void {
  assert.equal(messages[0]?.role, 'user');
  const ids = (m: Message | undefined, type: string, key: 'id' | 'tool_use_id') =>
    (Array.isArray(m?.content) ? m.content : []).filter((b) => b.type === type).map((b) => b[key]);
  messages.forEach((m, i) => {
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
  private readonly rounds: Event[][];
  constructor(rounds: Event[][]) { this.rounds = rounds; }

  async messages(): Promise<never> { throw new Error('not scripted'); }
  async stream(_feature: string, body: Record<string, unknown>, signal?: AbortSignal) {
    const round = this.requests.length;
    this.requests.push(structuredClone(body));
    assertValid(body.messages as Message[]);
    const fail = this.fail?.round === round ? this.fail : undefined;
    if (fail && fail.event === undefined) throw new ClaudeError(fail.code);
    const events = this.rounds[round] ?? [];
    async function* gen() {
      for (const [i, e] of events.entries()) {
        if (signal?.aborted) throw new ClaudeError('ABORTED');
        if (fail?.event === i) throw new ClaudeError(fail.code);
        yield e;
      }
    }
    return { events: gen(), key: 'main' as const };
  }
  record(): void {}
  usage() { return { month: '2026-03', costCents: 0, backupActive: false }; }
}
