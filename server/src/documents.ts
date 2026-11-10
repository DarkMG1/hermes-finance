import { randomUUID } from 'node:crypto';
import type { DocumentRecordType, KeptDocument, ProfileKind } from '@hermes/shared';
import type { Db } from './db.ts';
import { ApiError } from './errors.ts';

const DAY_MS = 86_400_000;

/** Keeps a read's redacted pages, unlinked until a save links it. */
export function saveDocument(db: Db, kind: ProfileKind, pages: Buffer[], now: Date): string {
  const id = randomUUID();
  db.transaction(() => {
    db.prepare('INSERT INTO documents (id, kind, page_count, created_at) VALUES (?, ?, ?, ?)').run(id, kind, pages.length, now.toISOString());
    const add = db.prepare('INSERT INTO document_pages (document_id, idx, jpeg) VALUES (?, ?, ?)');
    pages.forEach((p, i) => add.run(id, i + 1, p));
  })();
  return id;
}

/** A read never saved leaves no pages behind for more than a day. */
export function purgeUnlinked(db: Db, now: Date): number {
  return db.prepare('DELETE FROM documents WHERE created_at < ? AND NOT EXISTS (SELECT 1 FROM document_links l WHERE l.document_id = documents.id)')
    .run(new Date(now.getTime() - DAY_MS).toISOString()).changes;
}

const recordTypeOf = (kind: ProfileKind): DocumentRecordType => (kind === 'offer' ? 'job' : kind);
const orphan = (db: Db, id: string) => db.prepare('DELETE FROM documents WHERE id = ? AND NOT EXISTS (SELECT 1 FROM document_links WHERE document_id = ?)').run(id, id);

/** Links a save to the document it was read from (of the record's kind); no documentId is a no-op. Call inside the save's transaction. */
export function linkDocument(db: Db, documentId: string | undefined, recordType: DocumentRecordType, recordId: string): void {
  if (documentId === undefined) return;
  const kind = db.prepare('SELECT kind FROM documents WHERE id = ?').pluck().get(documentId) as ProfileKind | undefined;
  if (!kind) throw new ApiError(400, 'INVALID_REQUEST', 'documentId: unknown document', 'documentId');
  if (recordTypeOf(kind) !== recordType) throw new ApiError(400, 'INVALID_REQUEST', `documentId: a ${kind} document can't be linked to a ${recordType}`, 'documentId');
  db.prepare('INSERT OR IGNORE INTO document_links (document_id, record_type, record_id) VALUES (?, ?, ?)').run(documentId, recordType, recordId);
}

/** A record that only the latest form applies to (W-4, state form, tax return): a new document replaces its link; one left with no links goes. */
export function replaceLink(db: Db, documentId: string | undefined, recordType: DocumentRecordType, recordId: string): void {
  if (documentId === undefined) return;
  linkDocument(db, documentId, recordType, recordId);
  const old = db.prepare('SELECT document_id FROM document_links WHERE record_type = ? AND record_id = ? AND document_id <> ?').pluck().all(recordType, recordId, documentId) as string[];
  db.prepare('DELETE FROM document_links WHERE record_type = ? AND record_id = ? AND document_id <> ?').run(recordType, recordId, documentId);
  for (const id of old) orphan(db, id);
}

/** A deleted record drops its links; a document it was the last link of goes too. Call inside the delete's transaction. */
export function unlinkRecord(db: Db, recordType: DocumentRecordType, recordId: string): void {
  const ids = db.prepare('SELECT document_id FROM document_links WHERE record_type = ? AND record_id = ?').pluck().all(recordType, recordId) as string[];
  db.prepare('DELETE FROM document_links WHERE record_type = ? AND record_id = ?').run(recordType, recordId);
  for (const id of ids) orphan(db, id);
}

const DOC = 'SELECT id, kind, created_at AS createdAt, page_count AS pageCount FROM documents';
const withLinks = (db: Db, d: Omit<KeptDocument, 'links'>): KeptDocument => ({ ...d,
  links: db.prepare('SELECT record_type AS recordType, record_id AS recordId FROM document_links WHERE document_id = ? ORDER BY record_type, record_id').all(d.id) as KeptDocument['links'] });

/** Newest first; with a record, only the documents linked to it. */
export function listDocuments(db: Db, record?: { recordType: DocumentRecordType; recordId: string }): KeptDocument[] {
  const rows = record
    ? db.prepare(`${DOC} WHERE id IN (SELECT document_id FROM document_links WHERE record_type = ? AND record_id = ?) ORDER BY created_at DESC, rowid DESC`).all(record.recordType, record.recordId)
    : db.prepare(`${DOC} ORDER BY created_at DESC, rowid DESC`).all();
  return (rows as Omit<KeptDocument, 'links'>[]).map((d) => withLinks(db, d));
}

export function getDocument(db: Db, id: string): KeptDocument | null {
  const d = db.prepare(`${DOC} WHERE id = ?`).get(id) as Omit<KeptDocument, 'links'> | undefined;
  return d ? withLinks(db, d) : null;
}

/** n from 1 */
export function documentPage(db: Db, id: string, n: number): Buffer | null {
  return (db.prepare('SELECT jpeg FROM document_pages WHERE document_id = ? AND idx = ?').pluck().get(id, n) as Buffer | undefined) ?? null;
}
