import type { Db } from './db.ts';

const ZELLE = /^zelle (?:payment|transfer) (?:to|from) (.+)$/i;

/** "Zelle - First" from bank text like "Zelle payment to FIRST LAST 123…"; null when the text names nobody. */
export function zellePayee(text: string): string | null {
  const rest = ZELLE.exec(text.trim())?.[1];
  if (!rest) return null;
  const words = rest.split(/\s+/);
  // the name ends at the first word with a digit: a reference code, sometimes glued to the last name
  const end = words.findIndex((word) => /\d/.test(word));
  const first = (end === -1 ? words : words.slice(0, end))[0]?.replace(/[^\p{L}'-]/gu, '');
  if (!first) return null;
  return `Zelle - ${first.charAt(0).toUpperCase()}${first.slice(1).toLowerCase()}`;
}

/** Names Zelle rows still showing the bank's text. Payees the owner set are left alone; running it again changes nothing. */
export function nameZellePayees(db: Db, nowIso: string): number {
  const rows = db.prepare(`SELECT id, bank_description AS text FROM transactions
    WHERE removed_at IS NULL AND bank_description LIKE 'zelle%' AND (payee IS NULL OR payee = bank_description)`).all() as
    { id: string; text: string }[];
  const rename = db.prepare('UPDATE transactions SET payee = ?, updated_at = ? WHERE id = ?');
  let named = 0;
  for (const r of rows) {
    const payee = zellePayee(r.text);
    if (payee) named += rename.run(payee, nowIso, r.id).changes;
  }
  return named;
}
