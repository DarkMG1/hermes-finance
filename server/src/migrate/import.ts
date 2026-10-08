import { randomUUID } from 'node:crypto';
import type { Db } from '../db.ts';
import type { ActualSnapshot } from './actual.ts';

export class MigrationError extends Error {}

export type AccountMapping = Record<string, string>; // Actual account id -> Hermes account id | 'new' | 'skip'
export type ImportCounts = {
  categories: number; accountsCreated: number; transactions: number; splitLines: number;
  splitRemainders: number; orphanCategories: number; retiredPlaid: number; offBudgetRows: number;
};

export function validateMapping(db: Db, snapshot: ActualSnapshot, mapping: AccountMapping): void {
  const problems: string[] = [];
  const actualIds = new Set(snapshot.accounts.map((a) => a.id));
  const exists = db.prepare('SELECT 1 FROM accounts WHERE id = ?');
  for (const a of snapshot.accounts) if (!Object.hasOwn(mapping, a.id)) problems.push(`unmapped Actual account ${a.id}`);
  for (const [id, to] of Object.entries(mapping)) {
    if (!actualIds.has(id)) problems.push(`mapping lists unknown Actual account ${id}`);
    else if (to !== 'new' && to !== 'skip' && !exists.get(to)) problems.push(`mapping target ${to} is not a Hermes account`);
  }
  if (problems.length) throw new MigrationError(problems.join('\n'));
}

export function applyImport(db: Db, snapshot: ActualSnapshot, mapping: AccountMapping, opts: { cutoverDate: string; nowIso: string }): ImportCounts {
  validateMapping(db, snapshot, mapping);
  const counts: ImportCounts = { categories: 0, accountsCreated: 0, transactions: 0, splitLines: 0, splitRemainders: 0, orphanCategories: 0, retiredPlaid: 0, offBudgetRows: 0 };

  const byName = db.prepare('SELECT id FROM categories WHERE name = ?');
  const insertCategory = db.prepare('INSERT INTO categories (id, name, group_name, is_income, is_transfer, hidden) VALUES (?, ?, ?, ?, ?, ?)');
  const categoryIds = new Map<string, string>();
  const seenNames = new Set<string>();
  for (const c of snapshot.categories) {
    const name = seenNames.has(c.name) ? `${c.name} (${c.groupName})` : c.name;
    seenNames.add(c.name);
    const existing = byName.get(name) as { id: string } | undefined;
    if (existing) {
      categoryIds.set(c.id, existing.id);
      continue;
    }
    const id = randomUUID();
    insertCategory.run(id, name, c.groupName, c.isIncome ? 1 : 0, 0, c.hidden ? 1 : 0);
    categoryIds.set(c.id, id);
    counts.categories += 1;
  }

  // excluded from spending via is_transfer; created on first use, or reused and flagged
  const specialIds = new Map<string, string>();
  const specialCategory = (name: string, hidden: number): string => {
    let id = specialIds.get(name);
    if (id) return id;
    const existing = byName.get(name) as { id: string } | undefined;
    if (existing) {
      db.prepare('UPDATE categories SET is_transfer = 1 WHERE id = ?').run(existing.id);
      id = existing.id;
    } else {
      id = randomUUID();
      insertCategory.run(id, name, name, 0, 1, hidden);
      counts.categories += 1;
    }
    specialIds.set(name, id);
    return id;
  };
  const offBudget = new Set(snapshot.accounts.filter((a) => a.offbudget).map((a) => a.id));
  const fallback = (isTransfer: boolean, accountId: string): string | null => {
    if (isTransfer) return specialCategory('Transfers', 0);
    if (!offBudget.has(accountId)) return null;
    counts.offBudgetRows += 1; // Actual never categorizes off-budget rows; uncategorized they'd count as spending
    return specialCategory('Off budget', 1);
  };
  const category = (actualId: string | null, isTransfer: boolean, accountId: string): string | null => {
    if (actualId) {
      const id = categoryIds.get(actualId);
      if (id) return id;
      counts.orphanCategories += 1;
    }
    return fallback(isTransfer, accountId);
  };

  const targets = new Map<string, string>(); // Actual account id -> Hermes account id
  const created = new Set<string>(); // Actual account ids imported into new accounts
  const insertAccount = db.prepare("INSERT INTO accounts (id, name, type, balance_current_cents, balance_at, hidden) VALUES (?, ?, 'other', ?, ?, ?)");
  for (const a of snapshot.accounts) {
    const to = mapping[a.id] as string;
    if (to === 'skip') continue;
    if (to === 'new') {
      const id = randomUUID();
      const balance = snapshot.transactions.filter((t) => t.accountId === a.id).reduce((s, t) => s + t.amountCents, 0);
      insertAccount.run(id, a.name, balance, opts.nowIso, a.closed ? 1 : 0);
      targets.set(a.id, id);
      created.add(a.id);
      counts.accountsCreated += 1;
    } else {
      targets.set(a.id, to);
    }
  }

  const insertTxn = db.prepare(`INSERT INTO transactions (id, account_id, source, source_id, date, amount_cents, bank_description,
      category_id, payee, notes, created_at, updated_at)
    VALUES (?, ?, 'actual', ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertLine = db.prepare('INSERT INTO split_lines (id, transaction_id, amount_cents, category_id, notes) VALUES (?, ?, ?, ?, ?)');
  for (const t of snapshot.transactions) {
    const accountId = targets.get(t.accountId);
    if (!accountId) continue;
    if (!created.has(t.accountId) && t.date >= opts.cutoverDate) continue;
    const id = randomUUID();
    const categoryId = t.lines.length ? null : category(t.categoryId, t.isTransfer, t.accountId);
    insertTxn.run(id, accountId, t.id, t.date, t.amountCents, t.importedPayee ?? t.payee ?? '', categoryId, t.payee, t.notes, opts.nowIso, opts.nowIso);
    counts.transactions += 1;
    if (!t.lines.length) continue;
    for (const l of t.lines) {
      insertLine.run(randomUUID(), id, l.amountCents, category(l.categoryId, l.isTransfer, t.accountId), l.notes);
      counts.splitLines += 1;
    }
    const remainder = t.amountCents - t.lines.reduce((s, l) => s + l.amountCents, 0);
    if (remainder !== 0) {
      insertLine.run(randomUUID(), id, remainder, fallback(false, t.accountId), null);
      counts.splitRemainders += 1;
    }
  }

  const retire = db.prepare("UPDATE transactions SET removed_at = ?, updated_at = ? WHERE account_id = ? AND source = 'plaid' AND date < ? AND removed_at IS NULL");
  const mappedHermesIds = new Set([...targets].filter(([actualId]) => !created.has(actualId)).map(([, hermesId]) => hermesId));
  for (const hermesId of mappedHermesIds) counts.retiredPlaid += retire.run(opts.nowIso, opts.nowIso, hermesId, opts.cutoverDate).changes;

  db.prepare("INSERT INTO settings (key, value) VALUES ('cutover_date', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(opts.cutoverDate);
  return counts;
}
