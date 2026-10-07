import Fastify, { type FastifyInstance } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import type { Deps } from './deps.ts';
import { ApiError } from './errors.ts';
import { ledgerRoutes } from './routes/ledger.ts';

function tokenMatches(header: string | undefined, token: string): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const given = Buffer.from(header.slice(7));
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function buildApp(deps: Deps): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 });

  app.addHook('onRequest', async (req) => {
    if (req.url === '/v1/health') return;
    if (!tokenMatches(req.headers.authorization, deps.config.apiToken)) {
      throw new ApiError(401, 'UNAUTHORIZED', 'missing or invalid token');
    }
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiError) {
      return reply.code(err.status).send({ code: err.code, message: err.message, ...(err.field ? { field: err.field } : {}) });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.code(status).send({ code: 'INVALID_REQUEST', message: 'invalid request' });
    }
    console.error(`[hermes] internal error ${err.name}${(err as { code?: string }).code ? ` ${(err as { code?: string }).code}` : ''}`);
    return reply.code(500).send({ code: 'INTERNAL', message: 'Internal error' });
  });

  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ code: 'NOT_FOUND', message: 'not found' }));

  app.get('/v1/health', async () => {
    const row = deps.db.prepare('SELECT MAX(version) AS v FROM migrations').get() as { v: number };
    return { ok: true, gitSha: deps.config.gitSha, dbVersion: row.v };
  });

  ledgerRoutes(app, deps);

  return app;
}
