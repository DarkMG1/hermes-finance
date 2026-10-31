import { ClaudeError, type Claude } from '../src/chat/anthropic.ts';

type Event = { type: string; [k: string]: unknown };

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
