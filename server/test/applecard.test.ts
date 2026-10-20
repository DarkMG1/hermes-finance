import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAppleCardCsv, parseCsv, sourceIds } from '../src/applecard.ts';
import { buildApp } from '../src/app.ts';
import { getSpending } from '../src/cashflow.ts';
import { AUTH, makeTestDeps, seedAccount, seedCategory, seedTxn } from './helpers.ts';

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

test('re-import fills an uncategorized row from a mapping learned since the first import', async () => {
  const { deps } = makeTestDeps();
  const app = buildApp(deps);
  seedCategory(deps.db, { id: 'dining', name: 'Dining' });
  await post(app, SEPT, 'k1');
  const cat = () => (deps.db.prepare("SELECT category_id FROM transactions WHERE source = 'applecard' AND amount_cents = -1234").get() as { category_id: string | null }).category_id;
  assert.equal(cat(), null);
  deps.db.prepare("INSERT INTO plaid_category_map (plaid_category, category_id) VALUES ('Restaurants', 'dining')").run();
  await post(app, SEPT, 'k2');
  assert.equal(cat(), 'dining');
  deps.db.prepare("UPDATE transactions SET category_id = NULL, category_owner_set = 1 WHERE source = 'applecard' AND amount_cents = -1234").run();
  await post(app, SEPT, 'k3');
  assert.equal(cat(), null);
});

const statement = (clearing: string) => `${HEADER}\n09/30/2026,${clearing},SYNTHETIC COFFEE,Synthetic Coffee,Restaurants,Purchase,5.00,Synthetic Person`;

test('identical same-day purchases that clear on different days are two charges, across statements', async () => {
  const { deps } = makeTestDeps();
  const app = buildApp(deps);
  const csvA = statement('09/30/2026');
  const csvB = statement('10/01/2026');
  const importCsv = async (csv: string, key: string) => (await post(app, csv, key)).json() as { accountId: string; added: number; updated: number };
  const a = await importCsv(csvA, 'ac-a');
  const b = await importCsv(csvB, 'ac-b');
  assert.deepEqual([a.added, a.updated, b.added, b.updated], [1, 0, 1, 0]);
  const count = () => (deps.db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE source = 'applecard'").get() as { n: number }).n;
  assert.equal(count(), 2);
  const balanceCents = () => (deps.db.prepare('SELECT balance_current_cents AS b FROM accounts WHERE id = ?').get(a.accountId) as { b: number }).b;
  assert.equal(balanceCents(), 1000, 'both charges count toward the card balance');
  const again = [await importCsv(csvA, 'ac-a2'), await importCsv(csvB, 'ac-b2')];
  assert.deepEqual(again.map((r) => [r.added, r.updated]), [[0, 1], [0, 1]], 'either statement re-imported updates, never duplicates');
  assert.equal(count(), 2);
});

test('rows imported before clearing dates were stored update on re-import instead of duplicating', async () => {
  const { deps } = makeTestDeps();
  const app = buildApp(deps);
  const csvA = statement('09/30/2026');
  await post(app, csvA, 'ac-a');
  deps.db.prepare("UPDATE transactions SET clearing_date = NULL WHERE source = 'applecard'").run();
  const again = (await post(app, csvA, 'ac-a2')).json() as { added: number; updated: number };
  assert.deepEqual([again.added, again.updated], [0, 1]);
  const rows = deps.db.prepare("SELECT clearing_date FROM transactions WHERE source = 'applecard'").all() as { clearing_date: string | null }[];
  assert.deepEqual(rows, [{ clearing_date: '2026-09-30' }]);
});

const coffee = (clearing: string) => `09/30/2026,${clearing},SYNTHETIC COFFEE,Synthetic Coffee,Restaurants,Purchase,5.00,Synthetic Person`;

test('a later identical row still claims the stored charge it matches after an earlier row skipped past it', async () => {
  const { deps } = makeTestDeps();
  const app = buildApp(deps);
  await post(app, statement('09/30/2026'), 'ac-a');
  const second = (await post(app, [HEADER, coffee('10/01/2026'), coffee('09/30/2026')].join('\n'), 'ac-b')).json() as { added: number; updated: number };
  assert.deepEqual([second.added, second.updated], [1, 1]);
  assert.equal((deps.db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE source = 'applecard'").get() as { n: number }).n, 2);
});

test('re-importing a statement with its identical rows in swapped order updates both', async () => {
  const { deps } = makeTestDeps();
  const app = buildApp(deps);
  await post(app, [HEADER, coffee('09/30/2026'), coffee('10/01/2026')].join('\n'), 'ac-a');
  const again = (await post(app, [HEADER, coffee('10/01/2026'), coffee('09/30/2026')].join('\n'), 'ac-b')).json() as { added: number; updated: number };
  assert.deepEqual([again.added, again.updated], [0, 2]);
  assert.equal((deps.db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE source = 'applecard'").get() as { n: number }).n, 2);
});

test('an undated identical row never takes the stored charge a dated row matches exactly', async () => {
  const { deps } = makeTestDeps();
  const app = buildApp(deps);
  const first = (await post(app, [HEADER, coffee('09/30/2026'), coffee('10/01/2026')].join('\n'), 'ac-a')).json() as { accountId: string };
  const balanceCents = () => (deps.db.prepare('SELECT balance_current_cents AS b FROM accounts WHERE id = ?').get(first.accountId) as { b: number }).b;
  const before = balanceCents();
  const again = (await post(app, [HEADER, coffee(''), coffee('09/30/2026')].join('\n'), 'ac-b')).json() as { added: number; updated: number };
  assert.deepEqual([again.added, again.updated], [0, 2]);
  assert.equal((deps.db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE source = 'applecard'").get() as { n: number }).n, 2);
  assert.equal(balanceCents(), before);
});

test('re-import keeps a date the owner changed', async () => {
  const { deps } = makeTestDeps();
  const app = buildApp(deps);
  await post(app, SEPT, 'k1');
  deps.db.prepare("UPDATE transactions SET date = '2026-10-01', date_owner_set = 1 WHERE source = 'applecard' AND amount_cents = -1234").run();
  await post(app, SEPT, 'k2');
  const dates = deps.db.prepare("SELECT date FROM transactions WHERE source = 'applecard' AND amount_cents IN (-1234, -105000) ORDER BY amount_cents").all();
  assert.deepEqual(dates, [{ date: '2026-09-03' }, { date: '2026-10-01' }]);
});

test('new rows take the category of the newest row with their merchant name ahead of the mapping', async () => {
  const { deps } = makeTestDeps();
  const app = buildApp(deps);
  seedAccount(deps.db, { id: 'a1' });
  seedCategory(deps.db, { id: 'dining', name: 'Dining' });
  seedCategory(deps.db, { id: 'coffee', name: 'Coffee' });
  seedCategory(deps.db, { id: 'grocery', name: 'Grocery' });
  deps.db.prepare("INSERT INTO plaid_category_map (plaid_category, category_id) VALUES ('Restaurants', 'dining')").run();
  seedTxn(deps.db, { id: 'old', accountId: 'a1', date: '2026-08-01', amountCents: -500, categoryId: 'coffee', payee: 'Synthetic Cafe' });
  seedTxn(deps.db, { id: 'old2', accountId: 'a1', date: '2026-08-01', amountCents: -500, categoryId: 'grocery', bankDescription: 'SYNTHETIC GROCER' });
  await post(app, SEPT, 'k1');
  const cat = (cents: number) => (deps.db.prepare("SELECT category_id FROM transactions WHERE source = 'applecard' AND amount_cents = ?").get(cents) as { category_id: string | null }).category_id;
  assert.deepEqual([cat(-1234), cat(-105000)], ['coffee', 'grocery']);
});
