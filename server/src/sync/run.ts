import type { Deps } from '../deps.ts';
import { decryptToken } from '../crypto.ts';
import { PlaidError, type SyncPage } from '../plaid/port.ts';
import { applyPages, getCutoverDate, upsertAccounts } from './apply.ts';

export type ItemResult = {
  itemId: string; institutionName: string; result: 'ok' | 'login_required' | 'error' | 'already_running';
  added: number; modified: number; removed: number;
};

const running = new Set<string>();
const MAX_RESTARTS = 3;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

async function fetchAllPages(deps: Deps, token: string, cursor: string | null): Promise<SyncPage[]> {
  for (let attempt = 0; ; attempt += 1) {
    const pages: SyncPage[] = [];
    let next = cursor;
    try {
      for (;;) {
        const p = await deps.plaid.transactionsSync(token, next);
        pages.push(p);
        next = p.nextCursor;
        if (!p.hasMore) return pages;
      }
    } catch (e) {
      if (e instanceof PlaidError && e.code === 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION' && attempt < MAX_RESTARTS) continue;
      throw e;
    }
  }
}

export async function syncItem(deps: Deps, itemId: string): Promise<ItemResult> {
  const { db } = deps;
  const item = db.prepare('SELECT id, institution_name, access_token_enc, cursor FROM items WHERE id = ?').get(itemId) as
    { id: string; institution_name: string; access_token_enc: string; cursor: string | null } | undefined;
  if (!item) throw new Error('unknown item');
  const base = { itemId, institutionName: item.institution_name, added: 0, modified: 0, removed: 0 };
  if (running.has(itemId)) return { ...base, result: 'already_running' };
  running.add(itemId);
  let runId: number | null = null;
  try {
    runId = Number(db.prepare('INSERT INTO sync_runs (item_id, started_at) VALUES (?, ?)').run(itemId, deps.now().toISOString()).lastInsertRowid);
    const token = decryptToken(item.access_token_enc, deps.config.tokenKey);
    const pages = await fetchAllPages(deps, token, item.cursor);
    const accounts = await deps.plaid.accountsGet(token);
    const nowIso = deps.now().toISOString();
    const counts = db.transaction(() => {
      upsertAccounts(db, itemId, accounts, nowIso);
      const c = applyPages(db, pages, { itemId, cutoverDate: getCutoverDate(db), nowIso });
      const last = pages[pages.length - 1];
      db.prepare("UPDATE items SET cursor = ?, status = 'ok', last_error_code = NULL, last_synced_at = ? WHERE id = ?").run(last?.nextCursor ?? item.cursor, nowIso, itemId);
      const insertPage = db.prepare('INSERT INTO sync_pages (sync_run_id, page_json, created_at) VALUES (?, ?, ?)');
      for (const p of pages) insertPage.run(runId, JSON.stringify(p), nowIso);
      db.prepare('UPDATE sync_runs SET finished_at = ?, added = ?, modified = ?, removed = ? WHERE id = ?').run(nowIso, c.added, c.modified, c.removed, runId);
      const cutoff = new Date(deps.now().getTime() - RETENTION_MS).toISOString();
      db.prepare('DELETE FROM sync_pages WHERE created_at < ?').run(cutoff);
      db.prepare('DELETE FROM idempotency_keys WHERE created_at < ?').run(cutoff);
      db.prepare('DELETE FROM link_sessions WHERE expires_at < ?').run(cutoff);
      return c;
    })();
    return { ...base, ...counts, result: 'ok' };
  } catch (e) {
    const code = e instanceof PlaidError ? e.code : 'SYNC_FAILED';
    const status = code === 'ITEM_LOGIN_REQUIRED' ? 'login_required' : 'error';
    console.error(`[hermes] sync failed item=${itemId} code=${code}`);
    try {
      db.prepare('UPDATE items SET status = ?, last_error_code = ? WHERE id = ?').run(status, code, itemId);
      if (runId !== null) db.prepare('UPDATE sync_runs SET finished_at = ?, error_code = ? WHERE id = ?').run(deps.now().toISOString(), code, runId);
    } catch {
      console.error(`[hermes] sync bookkeeping failed item=${itemId}`);
    }
    return { ...base, result: status };
  } finally {
    running.delete(itemId);
  }
}

export async function syncAll(deps: Deps): Promise<ItemResult[]> {
  const ids = (deps.db.prepare('SELECT id FROM items ORDER BY institution_name').all() as { id: string }[]).map((r) => r.id);
  const results: ItemResult[] = [];
  for (const id of ids) results.push(await syncItem(deps, id));
  return results;
}
