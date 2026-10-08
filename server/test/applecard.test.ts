import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAppleCardCsv, parseCsv, sourceIds } from '../src/applecard.ts';
import { buildApp } from '../src/app.ts';
import { getSpending } from '../src/ledger.ts';
import { AUTH, makeTestDeps, seedCategory } from './helpers.ts';

const HEADER = 'Transaction Date,Clearing Date,Description,Merchant,Category,Type,Amount (USD),Purchased By';
const SEPT = [
  HEADER,
  '09/01/2026,09/02/2026,"SYNTHETIC CAFE, SF",Synthetic Cafe,Restaurants,Purchase,12.34,Synthetic Person',
  '09/03/2026,09/04/2026,SYNTHETIC GROCER,Synthetic Grocer,Grocery,Purchase,"1,050.00",Synthetic Person',
  '09/10/2026,09/10/2026,ACH DEPOSIT SYNTHETIC,Synthetic Bank,Payment,Payment,-500.00,Synthetic Person',
  '09/12/2026,09/13/2026,SYNTHETIC CAFE REFUND,Synthetic Cafe,Restaurants,Credit,-2.00,Synthetic Person',
].join('\r\n');

async function post(app: ReturnType<typeof buildApp>, csv: string, key: string) {
  return app.inject({ method: 'POST', url: '/v1/imports/apple-card', headers: { ...AUTH, 'idempotency-key': key }, payload: { csv } });
}

test('parseCsv handles quotes, escaped quotes, CRLF, a BOM and blank lines', () => {
  assert.deepEqual(parseCsv('﻿a,b\r\n"x, y","say ""hi"""\n\n1,2\n'), [['a', 'b'], ['x, y', 'say "hi"'], ['1', '2']]);
  assert.throws(() => parseCsv('a,"open'), /unterminated quote/);
});

test('parseAppleCardCsv maps columns, converts dates and flips the sign', () => {
  const rows = parseAppleCardCsv(SEPT);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows[0], { transactionDate: '2026-09-01', clearingDate: '2026-09-02', description: 'SYNTHETIC CAFE, SF', merchant: 'Synthetic Cafe',
    category: 'Restaurants', type: 'Purchase', amountCents: -1234 });
  assert.equal(rows[1]?.amountCents, -105000);
  assert.equal(rows[2]?.amountCents, 50000);
});

test('parseAppleCardCsv names the missing column and the bad row', () => {
  assert.throws(() => parseAppleCardCsv('Transaction Date,Description,Type\n09/01/2026,X,Purchase'), /missing column "amount \(usd\)"/);
  assert.throws(() => parseAppleCardCsv(`${HEADER}\n2026-09-01,,X,,,Purchase,1.00,`), /row 2: Transaction Date must be MM\/DD\/YYYY/);
  assert.throws(() => parseAppleCardCsv(`${HEADER}\n09/01/2026,,X,,,Purchase,abc,`), /row 2: Amount is not a number/);
  assert.throws(() => parseAppleCardCsv(`${HEADER}\n02/30/2026,,X,,,Purchase,1.00,`), /row 2: Transaction Date/);
});

test('identical rows get distinct, stable source ids', () => {
  const rows = parseAppleCardCsv(`${HEADER}\n09/01/2026,,SAME,,,Purchase,3.00,\n09/01/2026,,SAME,,,Purchase,3.00,`);
  const ids = sourceIds(rows);
  assert.notEqual(ids[0], ids[1]);
  assert.deepEqual(sourceIds(rows), ids);
});

test('import creates the Apple Card account, stores rows and computes the owed balance', async () => {
  const { deps } = makeTestDeps();
  const app = buildApp(deps);
  const res = await post(app, SEPT, 'k1');
  assert.equal(res.statusCode, 200);
  const body = res.json() as { accountId: string; rows: number; added: number; updated: number; skippedBeforeCutover: number };
  assert.deepEqual({ ...body, accountId: 'x' }, { accountId: 'x', rows: 4, added: 4, updated: 0, skippedBeforeCutover: 0 });
  const acct = deps.db.prepare('SELECT name, type, subtype, balance_current_cents FROM accounts WHERE id = ?').get(body.accountId);
  // purchases 12.34 + 1050.00, payment -500.00, refund -2.00 (Apple's signs) => owed 560.34
  assert.deepEqual(acct, { name: 'Apple Card', type: 'credit', subtype: 'apple_card', balance_current_cents: 56034 });
  const payment = deps.db.prepare("SELECT plaid_category FROM transactions WHERE source = 'applecard' AND amount_cents = 50000").get() as { plaid_category: string };
  assert.equal(payment.plaid_category, 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT');
});

test('reimport is idempotent and an overlapping file only adds new rows', async () => {
  const { deps } = makeTestDeps();
  const app = buildApp(deps);
  await post(app, SEPT, 'k1');
  const again = (await post(app, SEPT, 'k2')).json() as { added: number; updated: number };
  assert.deepEqual([again.added, again.updated], [0, 4]);
  const more = (await post(app, `${SEPT}\r\n09/20/2026,09/21/2026,SYNTHETIC BOOKS,Synthetic Books,Shopping,Purchase,8.00,Synthetic Person`, 'k3')).json() as { added: number; updated: number };
  assert.deepEqual([more.added, more.updated], [1, 4]);
  assert.equal((deps.db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE source = 'applecard'").get() as { n: number }).n, 5);
});

test('identical rows are both kept', async () => {
  const { deps } = makeTestDeps();
  const app = buildApp(deps);
  await post(app, `${HEADER}\n09/01/2026,,SAME,,Restaurants,Purchase,3.00,\n09/01/2026,,SAME,,Restaurants,Purchase,3.00,`, 'k1');
  assert.equal((deps.db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE source = 'applecard'").get() as { n: number }).n, 2);
});

test('payments are not spending and refunds net against purchases', async () => {
  const { deps } = makeTestDeps();
  await post(buildApp(deps), SEPT, 'k1');
  const s = getSpending(deps.db, { period: 'month', date: '2026-09' });
  assert.equal(s.totalCents, 1234 + 105000 - 200);
});

test('rows before the account cutover are skipped; a global cutover alone does not apply', async () => {
  const { deps } = makeTestDeps();
  const app = buildApp(deps);
  deps.db.prepare("INSERT INTO settings (key, value) VALUES ('cutover_date', '2026-12-01')").run();
  const first = (await post(app, SEPT, 'k1')).json() as { accountId: string; skippedBeforeCutover: number };
  assert.equal(first.skippedBeforeCutover, 0);
  deps.db.prepare("UPDATE accounts SET cutover_date = '2026-09-05' WHERE id = ?").run(first.accountId);
  const second = (await post(app, `${HEADER}\n09/02/2026,,EARLY,,,Purchase,1.00,`, 'k2')).json() as { skippedBeforeCutover: number; added: number };
  assert.deepEqual([second.skippedBeforeCutover, second.added], [1, 0]);
});

test('import needs an idempotency key, rejects bad CSV as a field error, and accepts files over the default body limit', async () => {
  const { deps } = makeTestDeps();
  const app = buildApp(deps);
  const noKey = await app.inject({ method: 'POST', url: '/v1/imports/apple-card', headers: AUTH, payload: { csv: SEPT } });
  assert.equal(noKey.statusCode, 400);
  const badCsv = await post(app, 'nope', 'k1');
  assert.equal(badCsv.statusCode, 400);
  assert.equal((badCsv.json() as { code: string; field: string }).field, 'csv');
  const big = [HEADER, ...Array.from({ length: 1500 }, (_, i) => `09/01/2026,,SYNTHETIC ROW ${i},,Shopping,Purchase,1.00,Synthetic Person`)].join('\n');
  assert.ok(big.length > 64 * 1024);
  assert.equal((await post(app, big, 'k2')).statusCode, 200);
});

test('new rows take the mapped category on insert; re-import never overwrites an edited one', async () => {
  const { deps } = makeTestDeps();
  const app = buildApp(deps);
  seedCategory(deps.db, { id: 'dining', name: 'Dining' });
  seedCategory(deps.db, { id: 'other', name: 'Other' });
  deps.db.prepare("INSERT INTO plaid_category_map (plaid_category, category_id) VALUES ('Restaurants', 'dining')").run();
  await post(app, SEPT, 'k1');
  const cat = () => (deps.db.prepare("SELECT category_id FROM transactions WHERE source = 'applecard' AND amount_cents = -1234").get() as { category_id: string | null }).category_id;
  assert.equal(cat(), 'dining');
  deps.db.prepare("UPDATE transactions SET category_id = 'other' WHERE source = 'applecard' AND amount_cents = -1234").run();
  await post(app, SEPT, 'k2');
  assert.equal(cat(), 'other');
});
