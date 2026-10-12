import type { FastifyInstance } from 'fastify';
import { ReconcileBody, ReconcileQuery } from '@hermes/shared';
import type { Deps } from '../deps.ts';
import { idempotentWrite } from '../idempotency.ts';
import { getReconcile, reconcileMonths, setReconciled } from '../reconcile.ts';
import { parseBody } from '../validate.ts';

export function reconcileRoutes(app: FastifyInstance, deps: Deps): void {
  const { db } = deps;
  app.get('/v1/reconcile', async (req) => getReconcile(db, parseBody(ReconcileQuery, req.query).month));
  app.get('/v1/reconcile/months', async () => reconcileMonths(db));
  app.post<{ Params: { id: string } }>('/v1/transactions/:id/reconcile', async (req, reply) => {
    const body = parseBody(ReconcileBody, req.body);
    const r = idempotentWrite(deps, req, () => ({ status: 200, body: setReconciled(db, req.params.id, body.reconciled, deps.now().toISOString(), body.amountCents) }));
    return reply.code(r.status).send(r.body);
  });
}
