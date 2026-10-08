import { createHash } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { Deps } from './deps.ts';
import { ApiError } from './errors.ts';

type Result = { status: number; body: unknown };

function keyAndHash(req: FastifyRequest): { key: string; hash: string } {
  const key = req.headers['idempotency-key'];
  if (typeof key !== 'string' || key.length < 1 || key.length > 200) {
    throw new ApiError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header is required');
  }
  const hash = createHash('sha256').update(`${req.method} ${req.url}\n${JSON.stringify(req.body ?? null)}`).digest('hex');
  return { key, hash };
}

function lookup(deps: Deps, key: string, hash: string): Result | null {
  const row = deps.db.prepare('SELECT request_hash, status_code, response_json FROM idempotency_keys WHERE key = ?').get(key) as
    | { request_hash: string; status_code: number; response_json: string } | undefined;
  if (!row) return null;
  if (row.request_hash !== hash) throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key was used for a different request');
  return { status: row.status_code, body: JSON.parse(row.response_json) };
}

function save(deps: Deps, key: string, hash: string, r: Result): void {
  deps.db.prepare('INSERT INTO idempotency_keys (key, request_hash, status_code, response_json, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(key, hash, r.status, JSON.stringify(r.body), deps.now().toISOString());
}

// For DB-only writes: the write and the key commit together or not at all.
export function idempotentWrite(deps: Deps, req: FastifyRequest, run: () => Result): Result {
  const { key, hash } = keyAndHash(req);
  return deps.db.transaction(() => {
    const prior = lookup(deps, key, hash);
    if (prior) return prior;
    const r = run();
    save(deps, key, hash, r);
    return r;
  })();
}

// For writes that call Plaid first. run() must make its own DB changes idempotent.
export async function idempotentAsync(deps: Deps, req: FastifyRequest, run: () => Promise<Result>): Promise<Result> {
  const { key, hash } = keyAndHash(req);
  const prior = lookup(deps, key, hash);
  if (prior) return prior;
  const r = await run();
  if (r.status === 202) return r; // not final: a retry with the same key must re-check
  deps.db.transaction(() => { if (!lookup(deps, key, hash)) save(deps, key, hash, r); })();
  return r;
}
