import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nameZellePayees, zellePayee } from '../src/zelle.ts';
import { makeTestDeps, seedAccount, seedTxn } from './helpers.ts';

const NOW = '2026-03-15T12:00:00.000Z';
const text = (kind: 'payment' | 'transfer', rest: string) => `Zelle ${kind} ${rest}`;

test('zellePayee reads the first name in each bank format', () => {
  assert.equal(zellePayee('Zelle payment to QUILL WREN 12345678901'), 'Zelle - Quill');
  assert.equal(zellePayee('ZELLE PAYMENT FROM quill wren 98765'), 'Zelle - Quill');
  assert.equal(zellePayee(text('transfer', 'To Moss Fern Wren')), 'Zelle - Moss');
  assert.equal(zellePayee(text('transfer', 'from Fern Moss')), 'Zelle - Fern');
  assert.equal(zellePayee(text('transfer', 'to Wren Quill Moss12ab3c')), 'Zelle - Wren');
  assert.equal(zellePayee('  Zelle payment to FERN  MOSS 1  '), 'Zelle - Fern');
  assert.equal(zellePayee('Zelle payment from WREN, QUILL 123'), 'Zelle - Wren');
});

test('zellePayee returns null when the text names nobody or is not Zelle', () => {
  const bare = text('transfer', '').trim();
  for (const t of [bare, 'Zelle payment to 12345678901', 'Zelle payment to ., 123', 'SYNTHETIC COFFEE', 'Venmo payment to Quill', '']) {
    assert.equal(zellePayee(t), null, t);
  }
});

test('nameZellePayees names rows still showing bank text, skips owner payees and removed rows, and is idempotent', () => {
  const bare = text('transfer', '').trim();
  const { deps } = makeTestDeps();
  seedAccount(deps.db, { id: 'a1' });
  const z = (id: string, bankDescription: string, payee: string | null, extra: { removedAt?: string } = {}) =>
    seedTxn(deps.db, { id, accountId: 'a1', date: '2026-03-01', amountCents: 100, source: 'plaid', sourceId: id, bankDescription, payee, ...extra });
  z('new', 'Zelle payment from QUILL WREN 123', null);
  const old = text('transfer', 'To Moss Fern');
  z('old', old, old);
  z('mine', 'Zelle payment to FERN MOSS 456', 'Synthetic Rent');
  z('gone', 'Zelle payment to WREN QUILL 789', null, { removedAt: 'x' });
  z('noname', bare, bare);
  assert.equal(nameZellePayees(deps.db, NOW), 2);
  const payee = (id: string) => (deps.db.prepare('SELECT payee AS p FROM transactions WHERE id = ?').get(id) as { p: string | null }).p;
  assert.deepEqual(['new', 'old', 'mine', 'gone', 'noname'].map(payee),
    ['Zelle - Quill', 'Zelle - Moss', 'Synthetic Rent', null, bare]);
  assert.equal(nameZellePayees(deps.db, NOW), 0);
});
