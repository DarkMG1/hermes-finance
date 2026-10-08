import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSnapshot, type ActualApi } from '../src/migrate/actual.ts';

function fakeApi(overrideTxns?: ActualApi['getTransactions']): ActualApi {
  return {
    getAccounts: async () => [
      { id: 'A1', name: 'Synthetic Checking', offbudget: false, closed: false },
      { id: 'A2', name: 'Synthetic Savings', closed: true },
    ],
    getCategoryGroups: async () => [
      { id: 'G1', name: 'Synthetic Group', categories: [{ id: 'C1', name: 'Synthetic Cat A' }] },
      { id: 'G2', name: 'Synthetic Income', is_income: true, hidden: true, categories: [{ id: 'C2', name: 'Synthetic Pay' }] },
    ],
    getPayees: async () => [{ id: 'P1', name: 'Synthetic Store' }, { id: 'P2', name: '', transfer_acct: 'A2' }],
    getTransactions: overrideTxns ?? (async (accountId) => (accountId === 'A1'
      ? [
        { id: 'T1', account: 'A1', date: '2026-01-02', amount: -1500, category: 'C1', payee: 'P1', imported_payee: 'SYNTH STORE 001', notes: 'n1' },
        { id: 'T2', account: 'A1', date: '2026-01-03', amount: -3000, is_parent: true, payee: 'P1', category: 'C1', subtransactions: [
          { id: 'T2a', account: 'A1', date: '2026-01-03', amount: -2000, category: 'C1', is_child: true, parent_id: 'T2' },
          { id: 'T2b', account: 'A1', date: '2026-01-03', amount: -1000, category: null, transfer_id: 'X1', is_child: true, parent_id: 'T2' },
        ] },
        { id: 'T3', account: 'A1', date: '2026-01-04', amount: -5000, payee: 'P2', transfer_id: 'T4' },
        { id: 'T9', account: 'A1', date: '2026-01-05', amount: -1, tombstone: true },
      ]
      : [
        { id: 'T5', account: 'A2', date: '2026-01-06', amount: -900, is_parent: true },
        { id: 'T5a', account: 'A2', date: '2026-01-06', amount: -900, category: 'C2', is_child: true, parent_id: 'T5' },
      ])),
  };
}

test('readSnapshot flattens accounts, categories with group flags, and transactions with split lines', async () => {
  const s = await readSnapshot(fakeApi());
  assert.deepEqual(s.accounts, [
    { id: 'A1', name: 'Synthetic Checking', offbudget: false, closed: false },
    { id: 'A2', name: 'Synthetic Savings', offbudget: false, closed: true },
  ]);
  assert.deepEqual(s.categories, [
    { id: 'C1', name: 'Synthetic Cat A', groupName: 'Synthetic Group', isIncome: false, hidden: false },
    { id: 'C2', name: 'Synthetic Pay', groupName: 'Synthetic Income', isIncome: true, hidden: true },
  ]);
  assert.deepEqual(s.transactions.map((t) => t.id), ['T1', 'T2', 'T3', 'T5']); // tombstone and child rows dropped
  const [t1, t2, t3, t5] = s.transactions;
  assert.deepEqual(t1, { id: 'T1', accountId: 'A1', date: '2026-01-02', amountCents: -1500, categoryId: 'C1', payee: 'Synthetic Store',
    importedPayee: 'SYNTH STORE 001', notes: 'n1', isTransfer: false, lines: [] });
  assert.equal(t2?.categoryId, null, 'a split parent carries no category of its own');
  assert.deepEqual(t2?.lines, [
    { amountCents: -2000, categoryId: 'C1', notes: null, isTransfer: false },
    { amountCents: -1000, categoryId: null, notes: null, isTransfer: true },
  ]);
  assert.equal(t3?.payee, 'Synthetic Savings', 'transfer payee falls back to the other account name');
  assert.equal(t3?.isTransfer, true);
  assert.deepEqual(t5?.lines, [{ amountCents: -900, categoryId: 'C2', notes: null, isTransfer: false }], 'top-level children are attached to their parent');
});

test('readSnapshot rejects a non-integer amount instead of rounding it', async () => {
  const api = fakeApi(async () => [{ id: 'T1', account: 'A1', date: '2026-01-02', amount: 12.5 }]);
  await assert.rejects(readSnapshot(api), /non-integer amount on T1/);
});
