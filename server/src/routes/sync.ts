import type { FastifyInstance } from 'fastify';
import type { Bank } from '@hermes/shared';
import type { Deps } from '../deps.ts';
import { idempotentAsync } from '../idempotency.ts';
import { syncAll } from '../sync/run.ts';

export function listBanks(deps: Deps): Bank[] {
  const rows = deps.db.prepare('SELECT id, institution_name, status, last_synced_at, last_error_code FROM items ORDER BY institution_name').all() as
    { id: string; institution_name: string; status: Bank['status']; last_synced_at: string | null; last_error_code: string | null }[];
  return rows.map((r) => ({ itemId: r.id, institutionName: r.institution_name, status: r.status, lastSyncedAt: r.last_synced_at, lastErrorCode: r.last_error_code }));
}

export function syncRoutes(app: FastifyInstance, deps: Deps): void {
  app.post('/v1/sync', async (req, reply) => {
    const r = await idempotentAsync(deps, req, async () => {
      const items = await syncAll(deps);
      // a sync that found another one already running did nothing; a retry with the same key must run again
      return { status: 200, body: { items }, final: !items.some((i) => i.result === 'already_running') };
    });
    return reply.code(r.status).send(r.body);
  });
  app.get('/v1/sync/status', async () => listBanks(deps));
}
