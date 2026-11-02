import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { CreatePersonBody, ForgiveBody, ListPeopleQuery, PatchPersonBody, PaybackBody, PaybackQuery, PeopleSettings, type PaybackChoices } from '@hermes/shared';
import type { Deps } from '../deps.ts';
import { localDay } from '../days.ts';
import { ApiError } from '../errors.ts';
import { parseBody } from '../validate.ts';
import { idempotentWrite } from '../idempotency.ts';
import { REIMBURSEMENT } from '../cashflow.ts';
import { memberships } from '../recurring.ts';
import { TXN_COLS, assertCategoryExists, getTransaction, lookups, rowToTransaction, type TxnRow } from '../ledger.ts';
import { entryKey, openItems, receiptIds, settlePerson } from '../ious.ts';
import { assertPersonTaggable, getPerson, listPeople, peopleSettings, suggestions } from '../people.ts';

export function peopleRoutes(app: FastifyInstance, deps: Deps): void {
  const { db } = deps;

  app.get('/v1/people', async (req) => listPeople(db, parseBody(ListPeopleQuery, req.query).all === '1'));

  app.get('/v1/people/suggestions', async () => suggestions(db, deps.now()));

  app.get('/v1/people/reimbursements-cleanup', async () => {
    const rows = db.prepare(`SELECT ${TXN_COLS} FROM transactions t WHERE removed_at IS NULL AND (
        EXISTS (SELECT 1 FROM categories c WHERE c.id = t.category_id AND ${REIMBURSEMENT})
        OR EXISTS (SELECT 1 FROM split_lines sl JOIN categories c ON c.id = sl.category_id WHERE sl.transaction_id = t.id AND ${REIMBURSEMENT}))
      ORDER BY date DESC, created_at DESC, rowid DESC LIMIT 500`).all() as TxnRow[];
    const l = lookups(db, rows, memberships(db, localDay(deps.now())));
    return { rows: rows.map((r) => rowToTransaction(r, l)) };
  });

  app.post<{ Params: { id: string } }>('/v1/people/suggestions/:id/dismiss', async (req, reply) => {
    const r = idempotentWrite(deps, req, () => {
      const res = db.prepare('UPDATE transactions SET repayment_dismissed = 1, updated_at = ? WHERE id = ? AND removed_at IS NULL')
        .run(deps.now().toISOString(), req.params.id);
      if (!res.changes) throw new ApiError(404, 'NOT_FOUND', 'transaction not found');
      return { status: 200, body: { ok: true } };
    });
    return reply.code(r.status).send(r.body);
  });

  app.post<{ Params: { id: string } }>('/v1/people/:id/forgive', async (req, reply) => {
    const body = parseBody(ForgiveBody, req.body);
    const r = idempotentWrite(deps, req, () => {
      const detail = getPerson(db, req.params.id);
      if (!detail) throw new ApiError(404, 'NOT_FOUND', 'person not found');
      const owed = detail.person.balanceCents;
      if (owed <= 0) throw new ApiError(409, 'NOTHING_OWED', "they don't owe you anything");
      if (body.amountCents > owed) throw new ApiError(400, 'INVALID_REQUEST', 'amountCents: more than they owe', 'amountCents');
      let categoryId = body.categoryId ?? null;
      if (categoryId) assertCategoryExists(db, categoryId, 'categoryId');
      else {
        categoryId = (db.prepare("SELECT id FROM categories WHERE lower(name) = 'gifts'").pluck().get() as string | undefined) ?? randomUUID();
        db.prepare("INSERT OR IGNORE INTO categories (id, name, group_name) VALUES (?, 'Gifts', 'Gifts')").run(categoryId);
      }
      const c = db.prepare('SELECT is_income, is_transfer FROM categories WHERE id = ?').get(categoryId) as { is_income: number; is_transfer: number };
      if (c.is_income || c.is_transfer) throw new ApiError(400, 'INVALID_REQUEST', 'categoryId: pick a spending category', 'categoryId');
      const id = randomUUID();
      const now = deps.now().toISOString();
      db.prepare(`INSERT INTO transactions (id, account_id, source, date, amount_cents, bank_description, payee, notes, forgiven, created_at, updated_at)
        VALUES (?, 'manual', 'manual', ?, 0, '', ?, ?, 1, ?, ?)`).run(id, body.date, `Forgave ${detail.person.name}`, body.notes ?? null, now, now);
      // opposite-sign lines on a $0 row: writeSplit's same-sign check would refuse them
      const line = db.prepare('INSERT INTO split_lines (id, transaction_id, amount_cents, category_id, person_id) VALUES (?, ?, ?, ?, ?)');
      line.run(`00-${randomUUID()}`, id, body.amountCents, null, req.params.id);
      line.run(`01-${randomUUID()}`, id, -body.amountCents, categoryId, null);
      return { status: 201, body: getTransaction(db, id, localDay(deps.now())) };
    });
    return reply.code(r.status).send(r.body);
  });

  app.get('/v1/people/settings', async () => peopleSettings(db));

  app.put('/v1/people/settings', async (req, reply) => {
    const body = parseBody(PeopleSettings, req.body);
    const r = idempotentWrite(deps, req, () => {
      if (body.repaymentAccountId === null) {
        db.prepare("DELETE FROM settings WHERE key = 'repayment_account_id'").run();
      } else {
        if (!db.prepare("SELECT 1 FROM accounts WHERE id = ? AND type = 'depository'").get(body.repaymentAccountId)) {
          throw new ApiError(400, 'INVALID_REQUEST', 'repaymentAccountId: not a bank account', 'repaymentAccountId');
        }
        db.prepare("INSERT INTO settings (key, value) VALUES ('repayment_account_id', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
          .run(body.repaymentAccountId);
      }
      return { status: 200, body: peopleSettings(db) };
    });
    return reply.code(r.status).send(r.body);
  });

  app.get<{ Params: { id: string } }>('/v1/people/:id', async (req) => {
    const detail = getPerson(db, req.params.id);
    if (!detail) throw new ApiError(404, 'NOT_FOUND', 'person not found');
    return detail;
  });

  app.post('/v1/people', async (req, reply) => {
    const body = parseBody(CreatePersonBody, req.body);
    const r = idempotentWrite(deps, req, () => {
      const id = randomUUID();
      db.prepare('INSERT INTO people (id, name, match_text, created_at) VALUES (?, ?, ?, ?)')
        .run(id, body.name, body.matchText ?? null, deps.now().toISOString());
      return { status: 201, body: getPerson(db, id)!.person };
    });
    return reply.code(r.status).send(r.body);
  });

  app.patch<{ Params: { id: string } }>('/v1/people/:id', async (req, reply) => {
    const body = parseBody(PatchPersonBody, req.body);
    const r = idempotentWrite(deps, req, () => {
      const current = getPerson(db, req.params.id);
      if (!current) throw new ApiError(404, 'NOT_FOUND', 'person not found');
      if (body.archived && current.person.balanceCents !== 0) {
        throw new ApiError(409, 'PERSON_HAS_BALANCE', 'archive a person once they are settled up', 'archived');
      }
      const sets: string[] = [];
      const args: unknown[] = [];
      if (body.name !== undefined) { sets.push('name = ?'); args.push(body.name); }
      if (body.matchText !== undefined) { sets.push('match_text = ?'); args.push(body.matchText); }
      if (body.archived !== undefined) { sets.push('archived = ?'); args.push(body.archived ? 1 : 0); }
      db.prepare(`UPDATE people SET ${sets.join(', ')} WHERE id = ?`).run(...args, req.params.id);
      return { status: 200, body: getPerson(db, req.params.id)!.person };
    });
    return reply.code(r.status).send(r.body);
  });

  /** The deposit (or one positive split line) as a payback: what it must be, and its entry key. */
  const paybackTarget = (id: string, lineId: string | null | undefined) => {
    const txn = getTransaction(db, id, localDay(deps.now()));
    if (!txn) throw new ApiError(404, 'NOT_FOUND', 'transaction not found');
    if (txn.forgiven) throw new ApiError(409, 'FORGIVENESS_LOCKED', 'delete the forgiveness to change it');
    if (txn.splitLines.length && !lineId) throw new ApiError(409, 'SPLIT_TRANSACTION', 'tag a split transaction through its lines', 'lineId');
    const line = lineId ? txn.splitLines.find((l) => l.id === lineId) : undefined;
    if (lineId && !line) throw new ApiError(404, 'NOT_FOUND', 'split line not found');
    if ((line?.amountCents ?? txn.amountCents) <= 0 || txn.paidByPersonId) throw new ApiError(400, 'INVALID_REQUEST', 'personId: a payback is money in', 'personId');
    return { txn, lineId: line?.id ?? null, cents: line?.amountCents ?? txn.amountCents };
  };

  app.get<{ Params: { id: string } }>('/v1/transactions/:id/payback', async (req) => {
    const q = parseBody(PaybackQuery, req.query);
    const t = paybackTarget(req.params.id, q.lineId);
    const key = entryKey(t.txn.id, t.lineId);
        const linked = (db.prepare('SELECT item_transaction_id AS transactionId, item_line_id AS lineId, amount_cents AS amountCents FROM iou_links WHERE payback_transaction_id = ? AND payback_line_id IS ? ORDER BY created_at, id')
      .all(t.txn.id, t.lineId) as PaybackChoices['linked']);
    return { items: openItems(settlePerson(db, q.personId, key), receiptIds(db)), linked: (t.txn.personId ?? t.txn.splitLines.find((l) => l.id === t.lineId)?.personId) === q.personId ? linked : [] };
  });

  app.put<{ Params: { id: string } }>('/v1/transactions/:id/payback', async (req, reply) => {
    const body = parseBody(PaybackBody, req.body);
    const r = idempotentWrite(deps, req, () => {
      const t = paybackTarget(req.params.id, body.lineId);
      assertPersonTaggable(db, body.personId, 'personId', t.txn.id);
      const open = new Map(openItems(settlePerson(db, body.personId, entryKey(t.txn.id, t.lineId)), new Set()).map((i) => [entryKey(i.transactionId, i.lineId), i]));
      const seen = new Set<string>();
      body.items.forEach((it, i) => {
        const k = entryKey(it.transactionId, it.lineId ?? null);
        if (!open.has(k) || seen.has(k)) throw new ApiError(400, 'INVALID_REQUEST', `items.${i}.transactionId: not an open item of this person`, `items.${i}.transactionId`);
        seen.add(k);
        if (it.amountCents > open.get(k)!.leftCents) throw new ApiError(400, 'INVALID_REQUEST', `items.${i}.amountCents: more than is left`, `items.${i}.amountCents`);
      });
      if (body.items.reduce((s, it) => s + it.amountCents, 0) > t.cents) throw new ApiError(400, 'INVALID_REQUEST', 'items: more than the payback', 'items');
      const now = deps.now().toISOString();
      // tag exactly like the person PATCH: the person clears the category and the owner decided
      if (t.lineId) {
        db.prepare('UPDATE split_lines SET person_id = ?, category_id = NULL WHERE id = ?').run(body.personId, t.lineId);
        db.prepare('UPDATE transactions SET updated_at = ? WHERE id = ?').run(now, t.txn.id);
      } else {
        db.prepare('UPDATE transactions SET person_id = ?, category_id = NULL, category_owner_set = 1, updated_at = ? WHERE id = ?').run(body.personId, now, t.txn.id);
      }
      db.prepare('DELETE FROM iou_links WHERE payback_transaction_id = ? AND payback_line_id IS ?').run(t.txn.id, t.lineId);
      const ins = db.prepare(`INSERT INTO iou_links (id, payback_transaction_id, payback_line_id, item_transaction_id, item_line_id, amount_cents, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`);
      body.items.forEach((it, i) => ins.run(randomUUID(), t.txn.id, t.lineId, it.transactionId, it.lineId ?? null, it.amountCents, `${now}#${String(i).padStart(2, '0')}`));
      return { status: 200, body: getTransaction(db, t.txn.id, localDay(deps.now())) };
    });
    return reply.code(r.status).send(r.body);
  });
}
