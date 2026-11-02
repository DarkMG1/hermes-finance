import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { parseAppleCardCsv, parseCsv } from '../src/applecard.ts';
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

test('CSV amount bounds reject huge purchases and credits before any ledger writes', async () => {
  const { deps } = makeTestDeps();
  const app = buildApp(deps);
  for (const amount of ['10000000.01', '-10000000.01', '10000000000000000000000000000000000', '9'.repeat(400)]) {
    const r = await post(app, `${HEADER}\n09/01/2026,,SYNTHETIC LIMIT,,,Purchase,${amount},`, `limit-${amount}`.slice(0, 200));
    assert.equal(r.statusCode, 400);
    assert.deepEqual([r.json().code, r.json().field], ['INVALID_CSV', 'csv']);
  }
  assert.equal(deps.db.prepare("SELECT COUNT(*) FROM transactions WHERE source = 'applecard'").pluck().get(), 0);
  for (const amount of ['10000000.00', '-10000000.00']) {
    assert.equal(Math.abs(parseAppleCardCsv(`${HEADER}\n09/01/2026,,SYNTHETIC LIMIT,,,Purchase,${amount},`)[0]!.amountCents), 1_000_000_000);
  }
});

test('20,000 duplicate rows use linear hashing on import and dated or undated reimport', async (t) => {
  const { deps } = makeTestDeps();
  const app = buildApp(deps);
  const createHash = crypto.createHash;
  let hashes = 0;
  t.mock.method(crypto, 'createHash', (...args: Parameters<typeof createHash>) => { hashes += 1; return createHash(...args); });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  for (const [index, clearing] of ['', '09/02/2026', '09/02/2026', ''].entries()) {
    hashes = 0;
    const csv = [HEADER, ...Array<string>(20_000).fill(`09/01/2026,${clearing},SYNTHETIC DUPLICATE,,,Purchase,1.00,`)].join('\n');
    const r = await post(app, csv, `linear-${index}`);
    assert.equal(r.statusCode, 200);
    assert.deepEqual([r.json().added, r.json().updated], index === 0 ? [20_000, 0] : [0, 20_000]);
    assert.ok(hashes <= 20_010, `hash count: ${hashes}`);
  }
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

test('re-import fills an uncategorized row from merchant memory learned since, never one the owner cleared', async () => {
  const { deps } = makeTestDeps();
  const app = buildApp(deps);
  seedAccount(deps.db, { id: 'a1' });
  seedCategory(deps.db, { id: 'coffee', name: 'Coffee' });
  seedCategory(deps.db, { id: 'grocery', name: 'Grocery' });
  await post(app, SEPT, 'k1');
  const cat = (cents: number) => (deps.db.prepare("SELECT category_id FROM transactions WHERE source = 'applecard' AND amount_cents = ?").get(cents) as { category_id: string | null }).category_id;
  assert.deepEqual([cat(-1234), cat(-105000)], [null, null]);
  seedTxn(deps.db, { id: 'old', accountId: 'a1', date: '2026-09-20', amountCents: -500, categoryId: 'coffee', payee: 'Synthetic Cafe' });
  seedTxn(deps.db, { id: 'old2', accountId: 'a1', date: '2026-09-20', amountCents: -500, categoryId: 'grocery', payee: 'Synthetic Grocer' });
  deps.db.prepare("UPDATE transactions SET category_owner_set = 1 WHERE source = 'applecard' AND amount_cents = -105000").run();
  await post(app, SEPT, 'k2');
  assert.deepEqual([cat(-1234), cat(-105000)], ['coffee', null]);
});

const statement = (clearing: string) => `${HEADER}\n09/30/2026,${clearing},SYNTHETIC COFFEE,Synthetic Coffee,Restaurants,Purchase,5.00,Synthetic Person`;

const grocer = (clearing: string) => `09/20/2026,${clearing},SYNTHETIC GROCER,Synthetic Grocer,Grocery,Purchase,20.00,Synthetic Person`;
const books = '10/05/2026,10/06/2026,SYNTHETIC BOOKS,Synthetic Books,Shopping,Purchase,8.00,Synthetic Person';

test('a lone re-exported row whose clearing date changed inside the file\'s clearing range updates the stored row', async () => {
  const { deps } = makeTestDeps();
  const app = buildApp(deps);
  const a = (await post(app, `${statement('09/30/2026')}\n${grocer('09/28/2026')}`, 'ac-a')).json() as { accountId: string };
  const id = deps.db.prepare("SELECT id FROM transactions WHERE bank_description = 'SYNTHETIC COFFEE'").pluck().get();
  const reexport = `${statement('10/01/2026')}\n${grocer('09/28/2026')}`;
  const b = (await post(app, reexport, 'ac-b')).json() as { added: number; updated: number };
  assert.deepEqual([b.added, b.updated], [0, 2]);
  assert.deepEqual(deps.db.prepare("SELECT id, clearing_date FROM transactions WHERE bank_description = 'SYNTHETIC COFFEE'").all(), [{ id, clearing_date: '2026-10-01' }]);
  assert.equal(deps.db.prepare('SELECT balance_current_cents FROM accounts WHERE id = ?').pluck().get(a.accountId), 2500);
  const again = (await post(app, reexport, 'ac-b2')).json() as { added: number; updated: number };
  assert.deepEqual([again.added, again.updated], [0, 2]);
  assert.equal(deps.db.prepare("SELECT COUNT(*) FROM transactions WHERE source = 'applecard'").pluck().get(), 2);
});

test('identical same-day purchases on consecutive statements stay separate in either import order', async () => {
  const sept = `${statement('09/30/2026')}\n${grocer('09/28/2026')}`;
  const oct = `${statement('10/01/2026')}\n${books}`;
  for (const order of [[sept, oct], [oct, sept]]) {
    const { deps } = makeTestDeps();
    const app = buildApp(deps);
    const first = (await post(app, order[0]!, 'first')).json() as { accountId: string };
    const second = (await post(app, order[1]!, 'second')).json() as { added: number; updated: number };
    assert.deepEqual([second.added, second.updated], [2, 0], order[0]!);
    assert.deepEqual(deps.db.prepare("SELECT clearing_date FROM transactions WHERE bank_description = 'SYNTHETIC COFFEE' ORDER BY clearing_date").pluck().all(),
      ['2026-09-30', '2026-10-01']);
    assert.equal(deps.db.prepare('SELECT balance_current_cents FROM accounts WHERE id = ?').pluck().get(first.accountId), 3800);
    for (const [k, file] of order.entries()) assert.equal((await post(app, file, `again-${k}`)).json().added, 0, 're-imports never duplicate');
  }
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
  seedTxn(deps.db, { id: 'old2', accountId: 'a1', date: '2026-08-01', amountCents: -500, categoryId: 'grocery', payee: 'Synthetic Grocer' });
  // a payment's text was once categorized: payments still keep the card-payment category
  seedTxn(deps.db, { id: 'old3', accountId: 'a1', date: '2026-08-01', amountCents: 500, categoryId: 'grocery', merchantName: 'Synthetic Bank' });
  seedCategory(deps.db, { id: 'card', name: 'Card Payment', isTransfer: true });
  deps.db.prepare("INSERT INTO plaid_category_map (plaid_category, category_id) VALUES ('LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', 'card')").run();
  await post(app, SEPT, 'k1');
  const cat = (cents: number) => (deps.db.prepare("SELECT category_id FROM transactions WHERE source = 'applecard' AND amount_cents = ?").get(cents) as { category_id: string | null }).category_id;
  assert.deepEqual([cat(-1234), cat(-105000), cat(50000)], ['coffee', 'grocery', 'card']);
  // re-import never overwrites the owner's category, nor fills one the owner cleared
  deps.db.prepare("UPDATE transactions SET category_id = 'dining' WHERE source = 'applecard' AND amount_cents = -1234").run();
  deps.db.prepare("UPDATE transactions SET category_id = NULL, category_owner_set = 1 WHERE source = 'applecard' AND amount_cents = -105000").run();
  await post(app, SEPT, 'k2');
  assert.deepEqual([cat(-1234), cat(-105000)], ['dining', null]);
});

test('corrected amounts keep transaction identity and owner edits and resize the split', async () => {
  const { deps } = makeTestDeps();
  const db = deps.db;
  const app = buildApp(deps);
  await post(app, statement('09/30/2026'), 'correction-first');
  const { id } = db.prepare("SELECT id FROM transactions WHERE source = 'applecard'").get() as { id: string };
  seedCategory(db, { id: 'synthetic', name: 'Synthetic Food' });
  db.prepare("UPDATE transactions SET date = '2026-10-02', date_owner_set = 1, category_id = NULL, category_owner_set = 1, payee = 'Synthetic Quill', notes = 'Synthetic note' WHERE id = ?").run(id);
  db.prepare('INSERT INTO split_lines (id, transaction_id, amount_cents, category_id) VALUES (?, ?, ?, ?)').run('s1', id, -300, 'synthetic');
  db.prepare('INSERT INTO split_lines (id, transaction_id, amount_cents, category_id) VALUES (?, ?, ?, ?)').run('s2', id, -200, null);
  const corrected = statement('10/01/2026').replace('5.00', '7.50');
  const response = await post(app, corrected, 'correction-next');
  assert.equal(response.statusCode, 200);
  assert.deepEqual([response.json().added, response.json().updated], [0, 1]);
  assert.deepEqual(db.prepare("SELECT id, date, category_id, payee, notes, amount_cents, clearing_date FROM transactions WHERE source = 'applecard'").all(),
    [{ id, date: '2026-10-02', category_id: null, payee: 'Synthetic Quill', notes: 'Synthetic note', amount_cents: -750, clearing_date: '2026-10-01' }]);
  assert.deepEqual(db.prepare('SELECT amount_cents FROM split_lines WHERE transaction_id = ? ORDER BY id').all(id), [{ amount_cents: -450 }, { amount_cents: -300 }]);
  const again = (await post(app, corrected, 'correction-repeat')).json();
  assert.deepEqual([again.added, again.updated], [0, 1]);
  assert.equal(db.prepare('SELECT balance_current_cents FROM accounts WHERE id = ?').pluck().get(again.accountId), 750);
});

test('an amount-only correction keeps the original transaction', async () => {
  const { deps } = makeTestDeps();
  const app = buildApp(deps);
  await post(app, statement('09/30/2026'), 'amount-first');
  const id = deps.db.prepare("SELECT id FROM transactions WHERE source = 'applecard'").pluck().get();
  const r = await post(app, statement('09/30/2026').replace('5.00', '7.50'), 'amount-next');
  assert.equal(r.statusCode, 200);
  assert.deepEqual([r.json().added, r.json().updated], [0, 1]);
  assert.deepEqual(deps.db.prepare("SELECT id, amount_cents, clearing_date FROM transactions WHERE source = 'applecard'").all(),
    [{ id, amount_cents: -750, clearing_date: '2026-09-30' }]);
});

test('owner-removed rows are never correction candidates or ambiguity for a live candidate', async () => {
  for (const live of [false, true]) {
    const { deps } = makeTestDeps();
    const app = buildApp(deps);
    const first = live ? [statement('09/30/2026'), coffee('10/01/2026').replace('5.00', '6.00')].join('\n') : statement('09/30/2026');
    await post(app, first, 'removed-first');
    deps.db.prepare("UPDATE transactions SET removed_at = '2026-10-01T00:00:00Z' WHERE amount_cents = -500").run();
    const removed = deps.db.prepare('SELECT * FROM transactions WHERE removed_at IS NOT NULL').get();
    const liveId = deps.db.prepare('SELECT id FROM transactions WHERE removed_at IS NULL').pluck().get();
    const r = await post(app, statement('10/02/2026').replace('5.00', '7.50'), 'removed-next');
    assert.equal(r.statusCode, 200);
    assert.deepEqual([r.json().added, r.json().updated], live ? [0, 1] : [1, 0]);
    assert.deepEqual(deps.db.prepare('SELECT * FROM transactions WHERE removed_at IS NOT NULL').get(), removed);
    const active = deps.db.prepare('SELECT id, amount_cents FROM transactions WHERE removed_at IS NULL').all() as { id: string; amount_cents: number }[];
    assert.equal(active.length, 1);
    assert.equal(active[0]!.amount_cents, -750);
    if (live) assert.equal(active[0]!.id, liveId);
    assert.equal(deps.db.prepare('SELECT balance_current_cents FROM accounts WHERE id = ?').pluck().get(r.json().accountId), 750);
  }
});

test('corrections never merge an ambiguous stored pair, a file pair, or another Apple row type', async () => {
  for (const scenario of ['stored pair', 'file pair', 'other type']) {
    const { deps } = makeTestDeps();
    const app = buildApp(deps);
    const first = scenario === 'stored pair' ? [HEADER, coffee('09/30/2026'), coffee('10/01/2026')].join('\n') : statement('09/30/2026');
    await post(app, first, 'ambiguous-first');
    const corrected = coffee('10/02/2026').replace('5.00', '7.50');
    const next = scenario === 'file pair' ? [HEADER, coffee('09/30/2026'), corrected].join('\n')
      : [HEADER, scenario === 'other type' ? corrected.replace('Purchase', 'Credit') : corrected].join('\n');
    const r = await post(app, next, 'ambiguous-next');
    assert.equal(r.statusCode, 200, scenario);
    assert.equal(r.json().added, 1, scenario);
    assert.equal(deps.db.prepare("SELECT COUNT(*) FROM transactions WHERE source = 'applecard'").pluck().get(), scenario === 'stored pair' ? 3 : 2, scenario);
  }
});

test('an equal-amount counterpart takes a clearing-date change instead of an amount correction', async () => {
  const { deps } = makeTestDeps();
  const app = buildApp(deps);
  await post(app, [HEADER, coffee('09/30/2026'), coffee('10/01/2026').replace('5.00', '7.50')].join('\n'), 'first');
  const before = deps.db.prepare("SELECT id, amount_cents AS a, clearing_date AS c FROM transactions ORDER BY amount_cents").all() as { id: string; a: number; c: string }[];
  const r = await post(app, [HEADER, coffee('09/30/2026'), coffee('10/02/2026').replace('5.00', '7.50')].join('\n'), 'next');
  assert.deepEqual([r.statusCode, r.json().added, r.json().updated], [200, 0, 2]);
  assert.deepEqual(deps.db.prepare("SELECT id, amount_cents AS a, clearing_date AS c FROM transactions ORDER BY amount_cents").all(),
    [{ ...before[0]!, c: '2026-10-02' }, before[1]]);
});

const cup = (amount: string, clearing = '09/30/2026') => coffee(clearing).replace('5.00', amount);
const csv = (...rows: string[]) => [HEADER, ...rows].join('\n');
const coffees = (db: ReturnType<typeof makeTestDeps>['deps']['db']) =>
  db.prepare("SELECT id, amount_cents AS a, clearing_date AS c FROM transactions WHERE bank_description = 'SYNTHETIC COFFEE' ORDER BY amount_cents, clearing_date").all() as { id: string; a: number; c: string }[];

test('a correction counts only unpaired file rows and unclaimed stored rows', async () => {
  const cases: [string[], string[], number[]][] = [
    [[cup('5.00'), cup('3.00')], [cup('7.50'), cup('3.00')], [-750, -300]],
    [[cup('5.00'), cup('5.00')], [cup('5.00'), cup('7.50')], [-750, -500]],
    [[cup('5.00'), cup('5.00', '10/01/2026')], [cup('5.00', '10/01/2026'), cup('7.50', '10/02/2026')], [-750, -500]],
  ];
  for (const [first, next, amounts] of cases) {
    const { deps } = makeTestDeps();
    const app = buildApp(deps);
    await post(app, csv(...first), 'first');
    const ids = new Set(coffees(deps.db).map((t) => t.id));
    const r = (await post(app, csv(...next), 'next')).json() as { added: number; updated: number };
    assert.deepEqual([r.added, r.updated], [0, 2], next.join());
    assert.deepEqual(coffees(deps.db).map((t) => t.a), amounts, next.join());
    assert.deepEqual(new Set(coffees(deps.db).map((t) => t.id)), ids, 'every stored row keeps its identity');
    const again = (await post(app, csv(...next), 'again')).json() as { added: number; updated: number };
    assert.deepEqual([again.added, again.updated], [0, 2], `re-import ${next.join()}`);
    assert.deepEqual(coffees(deps.db).map((t) => t.a), amounts);
  }
});

test('identical same-day purchases never merge when either side has two', async () => {
  const cases: [string[], string[], number][] = [
    [[coffee('09/30/2026'), coffee('10/01/2026')], [coffee('10/02/2026'), coffee('10/03/2026')], 4],
    [[coffee('09/30/2026')], [coffee('10/02/2026'), coffee('10/03/2026')], 3],
    [[coffee('09/30/2026'), coffee('10/01/2026')], [coffee('10/02/2026')], 3],
  ];
  for (const [first, next, count] of cases) {
    const { deps } = makeTestDeps();
    const app = buildApp(deps);
    await post(app, csv(...first), 'first');
    const before = coffees(deps.db);
    await post(app, csv(...next), 'next');
    assert.equal(coffees(deps.db).length, count, next.join());
    for (const row of before) assert.ok(coffees(deps.db).some((t) => t.id === row.id && t.c === row.c), 'stored rows keep their clearing dates');
  }
});

test('each import stamps its newest transaction date and an older statement never overwrites a newer one', async () => {
  const bakery = '09/25/2026,09/25/2026,SYNTHETIC BAKERY,Synthetic Bakery,Restaurants,Purchase,4.00,Synthetic Person';
  for (const newer of [cup('7.50', '10/01/2026'), coffee('10/01/2026')]) {
    const { deps } = makeTestDeps();
    const app = buildApp(deps);
    const old = csv(coffee('09/30/2026'), grocer('10/02/2026'));
    const stamps = () => deps.db.prepare('SELECT DISTINCT source_file_date FROM transactions').pluck().all();
    await post(app, old, 'old');
    assert.deepEqual(stamps(), ['2026-09-30']);
    await post(app, csv(newer, grocer('10/02/2026'), bakery, books), 'new');
    assert.deepEqual(stamps(), ['2026-10-05']);
    assert.equal(coffees(deps.db).length, 1, newer);
    const snapshot = deps.db.prepare('SELECT * FROM transactions ORDER BY id').all();
    const r = (await post(app, old, 'old-again')).json() as { added: number; updated: number };
    assert.deepEqual([r.added, r.updated], [0, 0], newer);
    assert.deepEqual(deps.db.prepare('SELECT * FROM transactions ORDER BY id').all(), snapshot, 'older statement re-import changes nothing');
    // rows imported before statements were stamped stay updatable
    deps.db.prepare('UPDATE transactions SET source_file_date = NULL').run();
    await post(app, old, 'legacy');
    assert.deepEqual(coffees(deps.db).map((t) => [t.a, t.c]), [[-500, '2026-09-30']], newer);
  }
});

test('import stores the bank date under an owner date, and old or far dates are never bounded', async () => {
  const { deps } = makeTestDeps();
  const app = buildApp(deps);
  await post(app, SEPT, 'k1');
  deps.db.prepare("UPDATE transactions SET date = '2026-10-01', date_owner_set = 1 WHERE source = 'applecard' AND amount_cents = -1234").run();
  await post(app, SEPT, 'k2');
  const cafe = deps.db.prepare("SELECT date, bank_date AS b FROM transactions WHERE source = 'applecard' AND amount_cents = -1234").get();
  assert.deepEqual(cafe, { date: '2026-10-01', b: '2026-09-01' });
  const odd = [HEADER, '12/31/1999,,SYNTHETIC OLD,,,Purchase,1.00,', '01/01/2031,,SYNTHETIC FAR,,,Purchase,2.00,'].join('\n');
  assert.equal((await post(app, odd, 'k3')).statusCode, 200);
  const dates = deps.db.prepare("SELECT bank_date AS b FROM transactions WHERE bank_description LIKE 'SYNTHETIC %' AND amount_cents IN (-100, -200) ORDER BY amount_cents").all();
  assert.deepEqual(dates, [{ b: '2031-01-01' }, { b: '1999-12-31' }]);
});

test('re-import clears an owner date that matches the bank date', async () => {
  const { deps } = makeTestDeps();
  const app = buildApp(deps);
  await post(app, SEPT, 'k1');
  deps.db.prepare("UPDATE transactions SET date_owner_set = 1 WHERE source = 'applecard' AND amount_cents = -1234").run();
  await post(app, SEPT, 'k2');
  assert.equal((deps.db.prepare("SELECT date_owner_set AS f FROM transactions WHERE source = 'applecard' AND amount_cents = -1234").get() as { f: number }).f, 0);
});
