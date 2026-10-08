import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { AppleCardImportResult, Bank, Home, LinkSession, Spending, SyncStatus, Transaction, TransactionPage } from '@hermes/shared';
import { buildFixtures, FIXTURE_DIR } from './fixtures/generate.ts';

const root = join(import.meta.dirname, '..', '..');

test('committed iOS fixtures match what the server returns today (run `npm run fixtures` to refresh)', async () => {
  const fresh = await buildFixtures();
  const dir = join(root, FIXTURE_DIR);
  assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith('.json')).sort(), Object.keys(fresh).sort());
  for (const [name, content] of Object.entries(fresh)) assert.equal(readFileSync(join(dir, name), 'utf8'), content, `${name} is stale`);
});

test('fixtures satisfy the shared contract', async () => {
  const f = Object.fromEntries(Object.entries(await buildFixtures()).map(([k, v]) => [k, JSON.parse(v) as unknown]));
  Home.parse(f['home.json']);
  TransactionPage.parse(f['transactions-page.json']);
  Transaction.parse(f['transaction.json']);
  Spending.parse(f['spending.json']);
  Bank.array().parse(f['banks.json']);
  SyncStatus.parse(f['sync-status.json']);
  LinkSession.parse(f['link-session.json']);
  Bank.parse(f['link-complete.json']);
  AppleCardImportResult.parse(f['apple-card-import.json']);
});
