import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { CreateLinkSessionBody } from '@hermes/shared';
import type { Deps } from '../deps.ts';
import { ApiError } from '../errors.ts';
import { parseBody } from '../validate.ts';
import { idempotentAsync } from '../idempotency.ts';
import { decryptToken, encryptToken } from '../crypto.ts';
import { syncItem } from '../sync/run.ts';
import { listBanks } from './sync.ts';

const SESSION_TTL_MS = 30 * 60 * 1000;

function bankById(deps: Deps, itemId: string) {
  const b = listBanks(deps).find((x) => x.itemId === itemId);
  if (!b) throw new Error('item vanished');
  return b;
}

export function bankRoutes(app: FastifyInstance, deps: Deps): void {
  const { db } = deps;

  app.get('/v1/banks', async () => listBanks(deps));

  app.post('/v1/plaid/link-sessions', async (req, reply) => {
    const body = parseBody(CreateLinkSessionBody, req.body);
    const r = await idempotentAsync(deps, req, async () => {
      let opts: { mode: 'create' } | { mode: 'update'; accessToken: string } = { mode: 'create' };
      if (body.mode === 'update') {
        const item = db.prepare('SELECT access_token_enc FROM items WHERE id = ?').get(body.itemId) as { access_token_enc: string } | undefined;
        if (!item) throw new ApiError(404, 'NOT_FOUND', 'bank not found');
        opts = { mode: 'update', accessToken: decryptToken(item.access_token_enc, deps.config.tokenKey) };
      }
      const link = await deps.plaid.createLinkToken(opts);
      const id = randomUUID();
      const ttl = new Date(deps.now().getTime() + SESSION_TTL_MS).toISOString();
      const expiresAt = link.expiration < ttl ? link.expiration : ttl;
      db.prepare('INSERT INTO link_sessions (id, link_token, mode, item_id, expires_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, link.linkToken, body.mode, body.mode === 'update' ? body.itemId : null, expiresAt);
      return { status: 201, body: { sessionId: id, url: link.hostedLinkUrl, expiresAt } };
    });
    return reply.code(r.status).send(r.body);
  });

  app.post<{ Params: { id: string } }>('/v1/plaid/link-sessions/:id/complete', async (req, reply) => {
    const s = db.prepare('SELECT * FROM link_sessions WHERE id = ?').get(req.params.id) as
      { id: string; link_token: string; mode: 'create' | 'update'; item_id: string | null; expires_at: string; completed_at: string | null } | undefined;
    if (!s) throw new ApiError(404, 'NOT_FOUND', 'link session not found');
    if (s.completed_at && s.item_id) return reply.code(200).send(bankById(deps, s.item_id));
    const expired = s.expires_at < deps.now().toISOString();

    const r = await idempotentAsync(deps, req, async () => {
      const result = await deps.plaid.getLinkResult(s.link_token);
      if (expired && result.status !== 'complete') throw new ApiError(410, 'LINK_SESSION_EXPIRED', 'link session expired; start again');
      if (result.status === 'pending') return { status: 202, body: { code: 'LINK_PENDING', message: 'bank linking not finished yet' } };
      if (result.status === 'exited') throw new ApiError(409, 'LINK_EXITED', 'bank linking was cancelled');

      let itemId = s.item_id;
      if (s.mode === 'create') {
        if (!result.publicToken) throw new ApiError(502, 'LINK_NO_TOKEN', 'Plaid returned no token');
        const ex = await deps.plaid.exchangePublicToken(result.publicToken);
        const enc = encryptToken(ex.accessToken, deps.config.tokenKey);
        itemId = db.transaction(() => {
          const existing = db.prepare('SELECT id FROM items WHERE plaid_item_id = ?').get(ex.itemId) as { id: string } | undefined;
          const id = existing?.id ?? randomUUID();
          if (existing) db.prepare("UPDATE items SET access_token_enc = ?, status = 'ok', last_error_code = NULL WHERE id = ?").run(enc, id);
          else db.prepare('INSERT INTO items (id, plaid_item_id, institution_name, access_token_enc) VALUES (?, ?, ?, ?)').run(id, ex.itemId, result.institutionName ?? 'Bank', enc);
          db.prepare('UPDATE link_sessions SET item_id = ?, completed_at = ? WHERE id = ?').run(id, deps.now().toISOString(), s.id);
          return id;
        })();
      } else {
        if (!itemId) throw new Error('update session without item');
        db.prepare("UPDATE items SET status = 'ok', last_error_code = NULL WHERE id = ?").run(itemId);
        db.prepare('UPDATE link_sessions SET completed_at = ? WHERE id = ?').run(deps.now().toISOString(), s.id);
      }
      await syncItem(deps, itemId);
      return { status: 200, body: bankById(deps, itemId) };
    });
    return reply.code(r.status).send(r.body);
  });
}
