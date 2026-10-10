import type { HistoryEntry, PeopleSettings, Person, PersonDetail, RepaymentSuggestion } from '@hermes/shared';
import type { Db } from './db.ts';
import { ApiError } from './errors.ts';
import { TXN_COLS, rowToTransaction, type TxnRow } from './ledger.ts';

// Every live amount between the owner and a person: split lines and unsplit transactions tagged with them, and manual rows they paid.
// Money out (negative) raises what they owe; money in, and a row they paid (its share counted as positive), lowers it.
export const TAGGED = `
  SELECT sl.person_id AS person_id, t.id AS transaction_id, sl.id AS line_id, t.date AS date,
         COALESCE(t.payee, t.merchant_name, t.bank_description) AS payee, sl.amount_cents AS amount, 0 AS paid_by
    FROM split_lines sl JOIN transactions t ON t.id = sl.transaction_id
   WHERE sl.person_id IS NOT NULL AND t.removed_at IS NULL
  UNION ALL
  SELECT t.person_id, t.id, NULL, t.date, COALESCE(t.payee, t.merchant_name, t.bank_description), t.amount_cents, 0
    FROM transactions t
   WHERE t.person_id IS NOT NULL AND t.removed_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM split_lines sl WHERE sl.transaction_id = t.id)
  UNION ALL
  SELECT t.paid_by_person_id, t.id, NULL, t.date, COALESCE(t.payee, t.merchant_name, t.bank_description), -t.amount_cents, 1
    FROM transactions t
   WHERE t.paid_by_person_id IS NOT NULL AND t.removed_at IS NULL AND t.source = 'manual' AND t.amount_cents < 0`;

type Tagged = { person_id: string; transaction_id: string; line_id: string | null; date: string; payee: string; amount: number; paid_by: number };
type PersonRow = { id: string; name: string; match_text: string | null; archived: number };

const toPerson = (r: PersonRow, balanceCents: number): Person =>
  ({ id: r.id, name: r.name, matchText: r.match_text, archived: r.archived === 1, balanceCents });

// people who owe the owner first, then people the owner owes, then the settled
const side = (cents: number): number => (cents > 0 ? 0 : cents < 0 ? 1 : 2);

export function listPeople(db: Db, includeArchived: boolean): Person[] {
  const balances = new Map((db.prepare(`SELECT person_id AS p, -SUM(amount) AS b FROM (${TAGGED}) GROUP BY person_id`).all() as
    { p: string; b: number }[]).map((r) => [r.p, r.b]));
  const rows = db.prepare('SELECT id, name, match_text, archived FROM people').all() as PersonRow[];
  // an archived person whose balance reopened (a repayment was removed) stays visible
  return rows.map((r) => toPerson(r, balances.get(r.id) ?? 0))
    .filter((p) => includeArchived || !p.archived || p.balanceCents !== 0)
    .sort((x, y) => side(x.balanceCents) - side(y.balanceCents) || Math.abs(y.balanceCents) - Math.abs(x.balanceCents) || x.name.localeCompare(y.name));
}

export function getPerson(db: Db, id: string): PersonDetail | null {
  const row = db.prepare('SELECT id, name, match_text, archived FROM people WHERE id = ?').get(id) as PersonRow | undefined;
  if (!row) return null;
  const items = db.prepare(`SELECT * FROM (${TAGGED}) WHERE person_id = ? ORDER BY date, transaction_id, line_id`).all(id) as Tagged[];
  let balance = 0;
  // computed on every read, so bank edits and removals rewrite the feed
  const history: HistoryEntry[] = items.map((t) => {
    balance -= t.amount;
    return {
      transactionId: t.transaction_id, lineId: t.line_id, date: t.date, payee: t.payee,
      kind: t.paid_by ? 'paidByThem' : t.amount < 0 ? 'forThem' : 'fromThem', effectCents: -t.amount, balanceAfterCents: balance, settled: balance === 0,
    };
  });
  return { person: toPerson(row, balance), history: history.reverse() };
}

/** A new tag or payer must name a live person; a person archived after being added stays valid on that same transaction. */
export function assertPersonTaggable(db: Db, personId: string | null | undefined, field: string, transactionId: string): void {
  if (personId === null || personId === undefined) return;
  const p = db.prepare('SELECT archived FROM people WHERE id = ?').get(personId) as { archived: number } | undefined;
  if (!p) throw new ApiError(400, 'INVALID_REQUEST', `${field}: unknown person`, field);
  if (p.archived && !db.prepare(`SELECT 1 FROM transactions WHERE id = ? AND (person_id = ? OR paid_by_person_id = ?)
      UNION ALL SELECT 1 FROM split_lines WHERE transaction_id = ? AND person_id = ?`)
    .get(transactionId, personId, personId, transactionId, personId)) {
    throw new ApiError(400, 'INVALID_REQUEST', `${field}: person is archived`, field);
  }
}

const SUGGESTION_DAYS = 60;

/** Untagged recent deposits that look like repayments, each with the person they most likely came from. */
export function suggestions(db: Db, now: Date): RepaymentSuggestion[] {
  const since = new Date(now.getTime() - SUGGESTION_DAYS * 86_400_000).toISOString().slice(0, 10);
  const people = listPeople(db, false).filter((p) => !p.archived);
  const rows = db.prepare(`SELECT ${TXN_COLS}, plaid_category FROM transactions t
     WHERE removed_at IS NULL AND person_id IS NULL AND category_id IS NULL AND amount_cents > 0 AND date >= ?
       AND NOT EXISTS (SELECT 1 FROM split_lines sl WHERE sl.transaction_id = t.id)
       AND repayment_dismissed = 0
       -- repayments land in the owner's chosen account, or any checking account; card credits (bill payments) never are
       AND account_id IN (SELECT id FROM accounts WHERE COALESCE(id = (SELECT s.value FROM settings s JOIN accounts a ON a.id = s.value
                                                                         WHERE s.key = 'repayment_account_id' AND a.hidden = 0 AND a.type = 'depository'),
                                                                 subtype = 'checking'))
     ORDER BY date DESC, id DESC`).all(since) as (TxnRow & { plaid_category: string | null })[];
  const out: RepaymentSuggestion[] = [];
  for (const r of rows) {
    const desc = r.bank_description.toLowerCase();
    const byMatch = people.find((p) => p.matchText && desc.includes(p.matchText.toLowerCase()));
    if (!byMatch && !r.plaid_category?.startsWith('TRANSFER_IN')) continue;
    const byName = people.find((p) => {
      const words = p.name.toLowerCase().split(/\s+/).filter(Boolean);
      return words.length > 0 && words.every((w) => desc.includes(w));
    });
    const byAmount = people.filter((p) => p.balanceCents === r.amount_cents);
    const person = byMatch ?? byName ?? (byAmount.length === 1 ? byAmount[0] : undefined);
    out.push({ transaction: rowToTransaction(db, r), personId: person?.id ?? null });
  }
  return out;
}

/** What everyone together owes the owner; people who are ahead count as zero. */
export function owedToYouCents(db: Db): number {
  return listPeople(db, true).reduce((s, p) => s + Math.max(p.balanceCents, 0), 0);
}

/** What the owner owes everyone together; people who owe the owner count as zero. */
export function youOweCents(db: Db): number {
  return listPeople(db, true).reduce((s, p) => s + Math.max(-p.balanceCents, 0), 0);
}

export function peopleSettings(db: Db): PeopleSettings {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'repayment_account_id'").get() as { value: string } | undefined;
  return { repaymentAccountId: row?.value ?? null };
}
