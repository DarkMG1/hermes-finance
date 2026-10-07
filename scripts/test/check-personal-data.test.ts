import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findPersonalData } from '../check-personal-data.ts';

const terms = ['Zorblax Bank', 'Quentin Example', 'cafe'];
const AT = '@';
const f = (path: string, content: string) => [{ path, content }];

test('term hit reports kind, line and index without matched text', () => {
  const res = findPersonalData(f('a.ts', 'ok\nsent to Quentin Example today'), terms);
  assert.deepEqual(res, [{ path: 'a.ts', line: 2, kind: 'term', termIndex: 1 }]);
  assert.ok(!JSON.stringify(res).includes('Quentin'));
});

test('terms match case-insensitively', () => {
  const res = findPersonalData(f('a.ts', 'ZORBLAX BANK'), terms);
  assert.equal(res[0]?.termIndex, 0);
});

test('term boundary: cafeteria no, Cafe! yes', () => {
  assert.deepEqual(findPersonalData(f('a.ts', 'the cafeteria'), terms), []);
  assert.equal(findPersonalData(f('a.ts', 'Cafe!'), terms).length, 1);
});

test('allowed emails pass, others flagged with line', () => {
  const ok = 'a@users.noreply.github.com b@example.com c@example.org d@host.test';
  assert.deepEqual(findPersonalData(f('a.ts', ok), []), []);
  const res = findPersonalData(f('a.ts', `x\nmail someone${AT}corp.io`), []);
  assert.deepEqual(res, [{ path: 'a.ts', line: 2, kind: 'email' }]);
});

test('docs/ path is flagged at line 0', () => {
  assert.deepEqual(findPersonalData(f('docs/plan.md', 'hi'), []), [
    { path: 'docs/plan.md', line: 0, kind: 'docs' },
  ]);
});

test('package-lock.json is skipped', () => {
  assert.deepEqual(findPersonalData(f('package-lock.json', `Zorblax Bank x${AT}y.io`), terms), []);
});

test('clean input returns []', () => {
  assert.deepEqual(findPersonalData(f('a.ts', 'const x = 1;'), terms), []);
});
