import type { HistoryEntry, PeopleSettings, Person, PersonDetail, RepaymentSuggestion } from '@hermes/shared';
import type { Db } from './db.ts';
import { localDay } from './days.ts';
import { memberships } from './recurring.ts';
import { ApiError } from './errors.ts';
import { TAGGED, entryKey, openItems, personEntries, personLinks, receiptIds, settle } from './ious.ts';
import { TXN_COLS, lookups, rowToTransaction, type TxnRow } from './ledger.ts';

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
  // same-day entries in the order they were recorded (rowid when one sync gave them the same created_at); ids are random
  const items = personEntries(db, id);
  const s = settle(items, personLinks(db, items));
  const withReceipt = receiptIds(db);
  let balance = 0;
  // computed on every read, so bank edits and removals rewrite the feed
  const history: HistoryEntry[] = items.map((t) => {
    balance -= t.amount;
    const key = entryKey(t.transaction_id, t.line_id);
    const item = s.items.get(key);
    const paidBack = s.paidBack.get(key);
    return {
      transactionId: t.transaction_id, lineId: t.line_id, date: t.date, payee: t.payee,
      kind: t.forgiven ? 'forgiven' : t.paid_by ? 'paidByThem' : t.amount < 0 ? 'forThem' : 'fromThem', effectCents: -t.amount, balanceAfterCents: balance, settled: balance === 0,
      hasReceipt: withReceipt.has(t.transaction_id),
      ...(item ? { leftCents: item.leftCents } : {}), ...(paidBack ? { paidBack } : {}),
    };
  });
  const spentOnThemCents = items.filter((t) => t.amount < 0 && !t.paid_by && !t.forgiven).reduce((s, t) => s - t.amount, 0);
  const forgivenCents = items.filter((t) => t.forgiven).reduce((s, t) => s + t.amount, 0);
  return { person: toPerson(row, balance), history: history.reverse(), spentOnThemCents, forgivenCents, openItems: openItems(s, withReceipt) };
}

/** A new tag or payer must name a live person; an archived person stays valid in the same role on that transaction. */
export function assertPersonTaggable(db: Db, personId: string | null | undefined, field: string, transactionId: string, role: 'person' | 'payer' = 'person'): void {
  if (personId === null || personId === undefined) return;
  const p = db.prepare('SELECT archived FROM people WHERE id = ?').get(personId) as { archived: number } | undefined;
  if (!p) throw new ApiError(400, 'INVALID_REQUEST', `${field}: unknown person`, field);
  if (p.archived && !(role === 'payer'
    ? db.prepare('SELECT 1 FROM transactions WHERE id = ? AND paid_by_person_id = ?').get(transactionId, personId)
    : db.prepare(`SELECT 1 FROM transactions WHERE id = ? AND person_id = ?
        UNION ALL SELECT 1 FROM split_lines WHERE transaction_id = ? AND person_id = ?`).get(transactionId, personId, transactionId, personId))) {
    throw new ApiError(400, 'INVALID_REQUEST', `${field}: person is archived`, field);
  }
}

const SUGGESTION_DAYS = 60;

/** Untagged recent deposits that look like repayments, each with the person they most likely came from. */
function repayments(db: Db, now: Date, people = listPeople(db, false).filter((p) => !p.archived)): { r: TxnRow; personId: string | null }[] {
  const since = new Date(now.getTime() - SUGGESTION_DAYS * 86_400_000).toISOString().slice(0, 10);
  const rows = db.prepare(`SELECT ${TXN_COLS}, plaid_category FROM transactions t
     WHERE removed_at IS NULL AND person_id IS NULL AND category_id IS NULL AND amount_cents > 0 AND date >= ?
       AND NOT EXISTS (SELECT 1 FROM split_lines sl WHERE sl.transaction_id = t.id)
       AND repayment_dismissed = 0
       -- repayments land in the owner's chosen account, or any checking account; card credits (bill payments) never are
       AND account_id IN (SELECT id FROM accounts WHERE COALESCE(id = (SELECT s.value FROM settings s JOIN accounts a ON a.id = s.value
                                                                         WHERE s.key = 'repayment_account_id' AND a.hidden = 0 AND a.type = 'depository'),
                                                                 subtype = 'checking'))
     ORDER BY date DESC, id DESC`).all(since) as (TxnRow & { plaid_category: string | null })[];
  const out: { r: TxnRow; personId: string | null }[] = [];
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
    out.push({ r, personId: person?.id ?? null });
  }
  return out;
}

export function suggestions(db: Db, now: Date): RepaymentSuggestion[] {
  const found = repayments(db, now);
  const l = lookups(db, found.map((f) => f.r), memberships(db, localDay(now)));
  return found.map((f) => ({ transaction: rowToTransaction(f.r, l), personId: f.personId }));
}

/** Home shares one balance read and counts suggestions without building Transactions. */
export function homePeople(db: Db, now: Date) {
  const people = listPeople(db, true);
  return {
    owedToYouCents: people.reduce((s, p) => s + Math.max(p.balanceCents, 0), 0),
    youOweCents: people.reduce((s, p) => s + Math.max(-p.balanceCents, 0), 0),
    repaymentSuggestions: repayments(db, now, people.filter((p) => !p.archived)).length,
  };
}

export function peopleSettings(db: Db): PeopleSettings {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'repayment_account_id'").get() as { value: string } | undefined;
  return { repaymentAccountId: row?.value ?? null };
}
