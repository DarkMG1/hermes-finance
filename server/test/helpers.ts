import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { openDb, migrate, type Db } from '../src/db.ts';
import { encryptToken } from '../src/crypto.ts';
import type { Deps } from '../src/deps.ts';
import { FakePlaid } from './fake-plaid.ts';

export const API_TOKEN = 'test-token-0123456789-0123456789-abcdef';
export const AUTH = { authorization: `Bearer ${API_TOKEN}` };

export function makeTestDeps(): { deps: Deps; plaid: FakePlaid } {
  const dir = mkdtempSync(join(tmpdir(), 'hermes-test-'));
  const db = openDb(join(dir, 'hermes.db'));
  migrate(db);
  const plaid = new FakePlaid();
  const deps: Deps = {
    db,
    plaid,
    now: () => new Date('2026-03-15T12:00:00Z'),
    config: {
      dbPath: join(dir, 'hermes.db'), apiToken: API_TOKEN, tokenKey: randomBytes(32), host: '127.0.0.1', port: 0,
      syncIntervalMs: 60_000, gitSha: 'test-sha', plaid: { clientId: 'x', secret: 'y', env: 'sandbox' },
    },
  };
  return { deps, plaid };
}

export function seedCategory(db: Db, c: { id: string; name: string; isIncome?: boolean; isTransfer?: boolean }): void {
  db.prepare('INSERT INTO categories (id, name, group_name, is_income, is_transfer) VALUES (?, ?, ?, ?, ?)')
    .run(c.id, c.name, 'Group', c.isIncome ? 1 : 0, c.isTransfer ? 1 : 0);
}

export function seedItem(deps: Deps, i: { id: string; plaidItemId: string; institutionName: string; accessToken: string; status?: string }): void {
  deps.db.prepare('INSERT INTO items (id, plaid_item_id, institution_name, access_token_enc, status) VALUES (?, ?, ?, ?, ?)')
    .run(i.id, i.plaidItemId, i.institutionName, encryptToken(i.accessToken, deps.config.tokenKey), i.status ?? 'ok');
}

export function seedAccount(db: Db, a: { id: string; itemId?: string; plaidAccountId?: string; type?: string; balanceCents?: number; hidden?: boolean }): void {
  db.prepare('INSERT INTO accounts (id, item_id, plaid_account_id, name, type, balance_current_cents, hidden) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(a.id, a.itemId ?? null, a.plaidAccountId ?? null, `Account ${a.id}`, a.type ?? 'depository', a.balanceCents ?? null, a.hidden ? 1 : 0);
}

export function seedTxn(db: Db, t: {
  id: string; accountId: string; date: string; amountCents: number; source?: 'plaid' | 'manual' | 'actual'; sourceId?: string;
  categoryId?: string | null; payee?: string | null; merchantName?: string | null; bankDescription?: string; removedAt?: string; pending?: boolean;
  plaidCategory?: string;
}): void {
  db.prepare(`INSERT INTO transactions (id, account_id, source, source_id, date, amount_cents, bank_description, merchant_name,
      pending, removed_at, category_id, payee, plaid_category, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'seed', 'seed')`)
    .run(t.id, t.accountId, t.source ?? 'manual', t.sourceId ?? null, t.date, t.amountCents, t.bankDescription ?? 'SYNTHETIC',
      t.merchantName ?? null, t.pending ? 1 : 0, t.removedAt ?? null, t.categoryId ?? null, t.payee ?? null, t.plaidCategory ?? null);
}

export function seedSplit(db: Db, s: { id: string; transactionId: string; amountCents: number; categoryId: string | null }): void {
  db.prepare('INSERT INTO split_lines (id, transaction_id, amount_cents, category_id) VALUES (?, ?, ?, ?)')
    .run(s.id, s.transactionId, s.amountCents, s.categoryId);
}
