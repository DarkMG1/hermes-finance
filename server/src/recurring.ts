import type { Deps } from './deps.ts';
import { PlaidError } from './plaid/port.ts';

const cents = (dollars: number) => Math.round(dollars * 100);

/** Replaces one Item's stored streams with Plaid's; any failure keeps the old rows and never reaches the sync. */
export async function refreshRecurring(deps: Deps, itemId: string, accessToken: string): Promise<void> {
  try {
    const streams = await deps.plaid.recurringGet(accessToken);
    const now = deps.now().toISOString();
    deps.db.transaction(() => {
      deps.db.prepare('DELETE FROM recurring_streams WHERE item_id = ?').run(itemId);
      const insert = deps.db.prepare(`INSERT INTO recurring_streams (stream_id, item_id, name, frequency, average_cents, last_cents, last_date, next_date, is_active, status, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const s of streams) {
        insert.run(s.streamId, itemId, s.name, s.frequency.toLowerCase(), cents(s.averageAmount), cents(s.lastAmount), s.lastDate, s.nextDate,
          s.isActive ? 1 : 0, s.status.toLowerCase(), now);
      }
    })();
  } catch (e) {
    console.error(`[hermes] recurring refresh failed code=${e instanceof PlaidError ? e.code : 'UNKNOWN'}`);
  }
}
