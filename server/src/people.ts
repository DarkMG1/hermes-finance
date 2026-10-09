import type { OwedItem, Person, PersonDetail, PersonItem } from '@hermes/shared';
import type { Db } from './db.ts';
import { ApiError } from './errors.ts';

// Every tagged, live amount: split lines with a person, and unsplit transactions with a person.
// Money out (negative) is owed to the owner; money in (positive) is a repayment.
export const TAGGED = `
  SELECT sl.person_id AS person_id, t.id AS transaction_id, sl.id AS line_id, t.date AS date,
         COALESCE(t.payee, t.merchant_name, t.bank_description) AS payee, sl.amount_cents AS amount
    FROM split_lines sl JOIN transactions t ON t.id = sl.transaction_id
   WHERE sl.person_id IS NOT NULL AND t.removed_at IS NULL
  UNION ALL
  SELECT t.person_id, t.id, NULL, t.date, COALESCE(t.payee, t.merchant_name, t.bank_description), t.amount_cents
    FROM transactions t
   WHERE t.person_id IS NOT NULL AND t.removed_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM split_lines sl WHERE sl.transaction_id = t.id)`;

type Tagged = { person_id: string; transaction_id: string; line_id: string | null; date: string; payee: string; amount: number };
type PersonRow = { id: string; name: string; match_text: string | null; archived: number };

const toPerson = (r: PersonRow, balanceCents: number): Person =>
  ({ id: r.id, name: r.name, matchText: r.match_text, archived: r.archived === 1, balanceCents });

export function listPeople(db: Db, includeArchived: boolean): Person[] {
  const balances = new Map((db.prepare(`SELECT person_id AS p, -SUM(amount) AS b FROM (${TAGGED}) GROUP BY person_id`).all() as
    { p: string; b: number }[]).map((r) => [r.p, r.b]));
  const rows = db.prepare(`SELECT id, name, match_text, archived FROM people ${includeArchived ? '' : 'WHERE archived = 0'}`).all() as PersonRow[];
  return rows.map((r) => toPerson(r, balances.get(r.id) ?? 0))
    .sort((x, y) => y.balanceCents - x.balanceCents || x.name.localeCompare(y.name));
}

export function getPerson(db: Db, id: string): PersonDetail | null {
  const row = db.prepare('SELECT id, name, match_text, archived FROM people WHERE id = ?').get(id) as PersonRow | undefined;
  if (!row) return null;
  const items = db.prepare(`SELECT * FROM (${TAGGED}) WHERE person_id = ? ORDER BY date, transaction_id, line_id`).all(id) as Tagged[];
  const item = (t: Tagged): PersonItem => ({ transactionId: t.transaction_id, lineId: t.line_id, date: t.date, payee: t.payee, amountCents: t.amount });
  const repayments = items.filter((t) => t.amount > 0).map(item);
  let left = repayments.reduce((s, r) => s + r.amountCents, 0);
  // repayments pay the oldest items first; computed on every read, so bank edits and removals can't leave it stale
  const owed: OwedItem[] = items.filter((t) => t.amount < 0).map((t) => {
    const paidCents = Math.min(-t.amount, left);
    left -= paidCents;
    return { ...item(t), paidCents, status: paidCents === -t.amount ? 'paid' : paidCents > 0 ? 'partial' : 'open' };
  });
  const balanceCents = -items.reduce((s, t) => s + t.amount, 0);
  return { person: toPerson(row, balanceCents), owed: owed.reverse(), repayments: repayments.reverse() };
}

/** A new tag must name a live person; a person archived after being tagged stays valid on that same transaction. */
export function assertPersonTaggable(db: Db, personId: string | null | undefined, field: string, transactionId: string): void {
  if (personId === null || personId === undefined) return;
  const p = db.prepare('SELECT archived FROM people WHERE id = ?').get(personId) as { archived: number } | undefined;
  if (!p) throw new ApiError(400, 'INVALID_REQUEST', `${field}: unknown person`, field);
  if (p.archived && !db.prepare(`SELECT 1 FROM transactions WHERE id = ? AND person_id = ?
      UNION ALL SELECT 1 FROM split_lines WHERE transaction_id = ? AND person_id = ?`).get(transactionId, personId, transactionId, personId)) {
    throw new ApiError(400, 'INVALID_REQUEST', `${field}: person is archived`, field);
  }
}
