import { createHash, randomUUID } from 'node:crypto';
import type { AppleCardImportResult } from '@hermes/shared';
import type { Db } from './db.ts';
import { ApiError } from './errors.ts';

// Wallet's Apple Card export: purchases positive, payments and credits negative. Hermes: negative = money out.
const AMOUNT_SIGN = -1;
const COLUMNS = {
  transactionDate: ['transaction date'], clearingDate: ['clearing date'], description: ['description'], merchant: ['merchant'],
  category: ['category'], type: ['type'], amount: ['amount (usd)', 'amount'],
} as const;
type Column = keyof typeof COLUMNS;
const REQUIRED: Column[] = ['transactionDate', 'description', 'type', 'amount'];
const MAX_ROWS = 20_000;

export type AppleCardRow = {
  transactionDate: string; clearingDate: string | null; description: string; merchant: string | null;
  category: string | null; type: string; amountCents: number;
};

function bad(message: string): never {
  throw new ApiError(400, 'INVALID_CSV', message, 'csv');
}

export function parseCsv(text: string): string[][] {
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') { field += '"'; i += 1; } else if (ch === '"') quoted = false; else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i += 1;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (quoted) bad('unterminated quote');
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

function usDate(value: string, rowNo: number, column: string): string {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
  const iso = m ? `${m[3]}-${(m[1] ?? '').padStart(2, '0')}-${(m[2] ?? '').padStart(2, '0')}` : '';
  const t = Date.parse(`${iso}T00:00:00Z`);
  if (!m || Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== iso) bad(`row ${rowNo}: ${column} must be MM/DD/YYYY`);
  return iso;
}

function cents(value: string, rowNo: number): number {
  const m = /^(-)?\$?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/.exec(value);
  if (!m) bad(`row ${rowNo}: Amount is not a number`);
  const n = Number((m[2] ?? '').replaceAll(',', '')) * 100 + Number((m[3] ?? '').padEnd(2, '0'));
  return m[1] ? -n : n;
}

export function parseAppleCardCsv(text: string): AppleCardRow[] {
  const [header, ...body] = parseCsv(text);
  if (!header) bad('the file is empty');
  if (body.length > MAX_ROWS) bad(`too many rows (max ${MAX_ROWS})`);
  const names = header.map((h) => h.trim().toLowerCase());
  const idx = Object.fromEntries((Object.keys(COLUMNS) as Column[])
    .map((k) => [k, names.findIndex((n) => (COLUMNS[k] as readonly string[]).includes(n))])) as Record<Column, number>;
  for (const k of REQUIRED) if (idx[k] < 0) bad(`missing column "${COLUMNS[k][0]}"`);
  return body.map((r, i) => {
    const rowNo = i + 2;
    const get = (k: Column) => (idx[k] >= 0 ? (r[idx[k]] ?? '').trim() : '');
    const clearing = get('clearingDate');
    const amount = AMOUNT_SIGN * cents(get('amount'), rowNo);
    return {
      transactionDate: usDate(get('transactionDate'), rowNo, 'Transaction Date'),
      clearingDate: clearing ? usDate(clearing, rowNo, 'Clearing Date') : null,
      description: get('description'), merchant: get('merchant') || null, category: get('category') || null,
      type: get('type'), amountCents: amount === 0 ? 0 : amount,
    };
  });
}

// Stable per row; identical rows (two same-day identical purchases) are told apart by their occurrence index.
export function sourceIds(rows: AppleCardRow[]): string[] {
  const seen = new Map<string, number>();
  return rows.map((r) => {
    const base = [r.transactionDate, r.description, r.type, r.amountCents].join('\u001f');
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return createHash('sha256').update(`${base}\u001f${n}`).digest('hex').slice(0, 32);
  });
}

export function importAppleCard(db: Db, rows: AppleCardRow[], nowIso: string): AppleCardImportResult {
  let accountId = (db.prepare("SELECT value FROM settings WHERE key = 'apple_card_account_id'").get() as { value: string } | undefined)?.value;
  if (!accountId || !db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(accountId)) {
    accountId = randomUUID();
    db.prepare("INSERT INTO accounts (id, name, type, subtype, balance_current_cents, balance_at) VALUES (?, 'Apple Card', 'credit', 'apple_card', 0, ?)").run(accountId, nowIso);
    db.prepare("INSERT INTO settings (key, value) VALUES ('apple_card_account_id', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(accountId);
  }
  // only a per-account cutover applies: Actual never held this card, so the global migration cutover is irrelevant here
  const cutover = (db.prepare('SELECT cutover_date FROM accounts WHERE id = ?').get(accountId) as { cutover_date: string | null }).cutover_date;
  const exists = db.prepare("SELECT 1 FROM transactions WHERE source = 'applecard' AND source_id = ?");
  const upsert = db.prepare(`
    INSERT INTO transactions (id, account_id, source, source_id, date, authorized_date, amount_cents, bank_description, merchant_name, plaid_category, category_id, created_at, updated_at)
    VALUES (@id, @accountId, 'applecard', @sourceId, @date, @date, @amount, @desc, @merchant, @plaidCategory,
      (SELECT category_id FROM plaid_category_map WHERE plaid_category = @plaidCategory), @now, @now)
    ON CONFLICT (source, source_id) DO UPDATE SET
      date = excluded.date, authorized_date = excluded.authorized_date, amount_cents = excluded.amount_cents,
      bank_description = excluded.bank_description, merchant_name = excluded.merchant_name, plaid_category = excluded.plaid_category,
      category_id = COALESCE(transactions.category_id, CASE WHEN transactions.category_owner_set = 0 THEN excluded.category_id END),
      updated_at = excluded.updated_at`);
  const result: AppleCardImportResult = { accountId, rows: rows.length, added: 0, updated: 0, skippedBeforeCutover: 0 };
  sourceIds(rows).forEach((sourceId, i) => {
    const r = rows[i] as AppleCardRow;
    if (cutover && r.transactionDate < cutover) { result.skippedBeforeCutover += 1; return; }
    if (exists.get(sourceId)) result.updated += 1; else result.added += 1;
    // payments must never count as spending; other rows keep Apple's category so refunds net against purchases
    const plaidCategory = r.type.toLowerCase() === 'payment' ? 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' : r.category;
    upsert.run({ id: randomUUID(), accountId, sourceId, date: r.transactionDate, amount: r.amountCents, desc: r.description,
      merchant: r.merchant, plaidCategory, now: nowIso });
  });
  const sum = (db.prepare("SELECT COALESCE(SUM(amount_cents), 0) AS s FROM transactions WHERE account_id = ? AND source = 'applecard' AND removed_at IS NULL")
    .get(accountId) as { s: number }).s;
  db.prepare('UPDATE accounts SET balance_current_cents = ?, balance_at = ? WHERE id = ?').run(sum === 0 ? 0 : -sum, nowIso, accountId);
  return result;
}
