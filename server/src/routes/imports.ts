import type { FastifyInstance } from 'fastify';
import { AppleCardImportBody } from '@hermes/shared';
import type { Deps } from '../deps.ts';
import { parseBody } from '../validate.ts';
import { idempotentWrite } from '../idempotency.ts';
import { importAppleCard, parseAppleCardCsv } from '../applecard.ts';

export function importRoutes(app: FastifyInstance, deps: Deps): void {
  app.post('/v1/imports/apple-card', { bodyLimit: 2 * 1024 * 1024 }, async (req, reply) => {
    const body = parseBody(AppleCardImportBody, req.body);
    const rows = parseAppleCardCsv(body.csv);
    const r = idempotentWrite(deps, req, () => ({ status: 200, body: importAppleCard(deps.db, rows, deps.now().toISOString()) }));
    return reply.code(r.status).send(r.body);
  });
}
