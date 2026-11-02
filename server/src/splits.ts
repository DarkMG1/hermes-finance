import { randomUUID } from 'node:crypto';
import type { PutSplitsBody } from '@hermes/shared';
import type { Db } from './db.ts';
import { ApiError } from './errors.ts';
import { assertCategoryExists } from './ledger.ts';
import { assertPersonTaggable } from './people.ts';
import { captureLinks, restoreLinks } from './ious.ts';

/** Checks split lines against a transaction's amount and makes them its split; the row's own category and person move onto the lines. */
export function writeSplit(db: Db, txnId: string, amountCents: number, lines: PutSplitsBody['lines'], field: string, nowIso: string): void {
  if (lines.length > 20) throw new ApiError(400, 'INVALID_REQUEST', `${field}: at most 20 lines`, field);
  lines.forEach((l, i) => assertCategoryExists(db, l.categoryId, `${field}.${i}.categoryId`));
  lines.forEach((l, i) => assertPersonTaggable(db, l.personId, `${field}.${i}.personId`, txnId));
  // lines share the transaction's sign: the app enters them as positive amounts, so it couldn't show anything else
  if (lines.some((l) => (l.amountCents < 0) !== (amountCents < 0))) {
    throw new ApiError(400, 'INVALID_REQUEST', `${field}: every line must have the same sign as the transaction`, field);
  }
  if (lines.length && lines.reduce((s, l) => s + l.amountCents, 0) !== amountCents) {
    throw new ApiError(400, 'INVALID_REQUEST', `${field}: must add up to the transaction amount`, field);
  }
  const kept = captureLinks(db, txnId);
  db.prepare('DELETE FROM split_lines WHERE transaction_id = ?').run(txnId);
  // ids sort in entry order (lines are read back ORDER BY id)
  const insert = db.prepare('INSERT INTO split_lines (id, transaction_id, amount_cents, category_id, notes, person_id, payee) VALUES (?, ?, ?, ?, ?, ?, ?)');
  lines.forEach((l, i) => insert.run(`${String(i).padStart(2, '0')}-${randomUUID()}`, txnId, l.amountCents, l.categoryId, l.notes ?? null, l.personId ?? null,
    l.payee || null));
  // a split transaction's category lives on its lines; the owner decided, so learned mappings leave it alone
  db.prepare('UPDATE transactions SET category_id = NULL, person_id = NULL, category_owner_set = 1, updated_at = ? WHERE id = ?').run(nowIso, txnId);
  restoreLinks(db, txnId, kept);
}
