import { randomUUID } from 'node:crypto';
import type { DocumentRecordType, KeptDocument, ProfileKind, ProfileReadResult } from '@hermes/shared';
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

/** A record re-saved from a document: the new document replaces its link; one left with no links goes. A W-4, state form, tax return or offer
 *  document describes one record, so it also leaves any other record of that type; a pay stub or tax form document can hold several. */
export function replaceLink(db: Db, documentId: string | undefined, recordType: DocumentRecordType, recordId: string): void {
  if (documentId === undefined) return;
  linkDocument(db, documentId, recordType, recordId);
  if (recordType !== 'pay_stub' && recordType !== 'tax_form') {
    db.prepare('DELETE FROM document_links WHERE document_id = ? AND record_type = ? AND record_id <> ?').run(documentId, recordType, recordId);
  }
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

/** The record each draft of a read updates when saved. A re-read: what this document is linked to (pay stubs by pay date and amounts,
 *  then by pay date, then any of its stubs left: same amounts first, then by pay date). Otherwise one
 *  plainly saved already: a stub by the duplicate test (pay date, gross, net; the draft's employer's job first), a form by year, kind and
 *  payer (case and edge spaces ignored), a return by year and jurisdiction, a W-4 or state form of the only job with the draft's employer.
 *  A fresh offer matches nothing: a second offer from an employer can be a new job. */
export function withRecordIds(db: Db, r: ProfileReadResult, documentId?: string): ProfileReadResult {
  const ids = (sql: string, ...args: unknown[]) => db.prepare(sql).pluck().all(...args) as string[];
  const linked = (type: DocumentRecordType) => (documentId ? ids('SELECT record_id FROM document_links WHERE document_id = ? AND record_type = ? ORDER BY record_id', documentId, type)[0] : undefined);
  const onlyJob = (join: string, employer: string | null, ...args: unknown[]) => {
    const jobs = ids(`SELECT j.id FROM jobs j JOIN ${join} WHERE lower(trim(j.employer)) = lower(trim(?))`, ...args, employer);
    return jobs.length === 1 ? jobs[0] : undefined;
  };
  const matched = <T extends object>(x: T, recordId: string | undefined) => (recordId ? { ...x, recordId } : x);
  switch (r.kind) {
    case 'pay_stub': {
      const used = new Set<string>();
      const { stubs } = r;
      const found: (string | undefined)[] = stubs.map(() => undefined);
      // each pass runs over every draft still unmatched, so a closer match is never taken by an earlier page's looser one
      const pass = (find: (d: (typeof stubs)[number]['draft']) => string[]) => stubs.forEach((s, i) => {
        const id = found[i] ? undefined : find(s.draft).find((x) => !used.has(x));
        if (id) { found[i] = id; used.add(id); }
      });
      const onDoc = (where: string, ...args: unknown[]) => (documentId ? ids(`SELECT s.id FROM pay_stubs s JOIN document_links l ON l.record_type = 'pay_stub'
        AND l.record_id = s.id WHERE l.document_id = ? ${where} ORDER BY s.pay_date, s.created_at, s.id`, documentId, ...args) : []);
      pass((d) => onDoc('AND s.pay_date = ? AND s.gross_cents = ? AND s.net_cents = ?', d.payDate, d.grossCents, d.netCents));
      pass((d) => onDoc('AND s.pay_date = ?', d.payDate));
      pass((d) => ids(`SELECT s.id FROM pay_stubs s LEFT JOIN jobs j ON j.id = s.job_id WHERE s.pay_date = ? AND s.gross_cents = ? AND s.net_cents = ?
        ORDER BY lower(trim(j.employer)) = lower(trim(?)) DESC, s.created_at, s.id`, d.payDate, d.grossCents, d.netCents, d.employer));
      // a re-read whose pay date reads differently still updates one of the document's own stubs
      pass((d) => onDoc('AND s.gross_cents = ? AND s.net_cents = ?', d.grossCents, d.netCents));
      pass(() => onDoc(''));
      return { ...r, stubs: stubs.map((s, i) => matched(s, found[i])) };
    }
    case 'tax_form': return matched(r, linked('tax_form') ?? ids(`SELECT id FROM tax_forms WHERE year = ? AND kind = ? AND lower(trim(payer)) = lower(trim(?))
      ORDER BY created_at, id`, r.draft.year, r.draft.kind, r.draft.payer)[0]);
    case 'tax_return': return matched(r, linked('tax_return') ?? ids('SELECT id FROM tax_returns WHERE year = ? AND jurisdiction = ?', r.draft.year, r.draft.jurisdiction)[0]);
    case 'w4': return matched(r, linked('w4') ?? onlyJob('w4s w ON w.job_id = j.id', r.draft.employer));
    case 'state_w4': {
      const job = onlyJob('state_w4s w ON w.job_id = j.id AND w.state = ?', r.draft.employer, r.draft.state);
      return matched(r, linked('state_w4') ?? (job && `${job}:${r.draft.state}`));
    }
    case 'offer': return matched(r, linked('job'));
  }
}
