import { z } from 'zod';
import { ExpensesQuery, ListTransactionsQuery, NetWorthQuery, PayeeHistoryQuery, SpendingQuery } from '@hermes/shared';
import type { Deps } from '../deps.ts';
import { ApiError } from '../errors.ts';
import { getExpenses, getPayeeHistory, getReimbursements, getSpending } from '../cashflow.ts';
import { getTransaction, listAccounts, listCategories, listTransactions } from '../ledger.ts';
import { getRecurring } from '../recurring.ts';
import { getPerson, listPeople } from '../people.ts';
import { openItems, receiptIds, settlePerson } from '../ious.ts';
import { getNetWorth } from '../networth.ts';
import { localDay } from '../days.ts';
import { getHoldingHistory, getInvestments } from '../investments.ts';
import { getChat, searchChats } from './store.ts';

export type ToolDef = { name: string; description: string; input_schema: Record<string, unknown> };
export const RESULT_MAX = 20_000;

/** What the tools know about the request: the conversation being answered. */
export type ToolContext = { chatId?: string };
type Entry = { def: ToolDef; schema: z.ZodType; run: (deps: Deps, q: unknown, today: string, ctx: ToolContext) => unknown };

const jsonSchema = (s: z.ZodType): Record<string, unknown> => {
  const out: Record<string, unknown> = z.toJSONSchema(s, { io: 'input' });
  delete out.$schema;
  return out;
};
const Range = NetWorthQuery.shape.range;
const Day = ListTransactionsQuery.shape.from;
const Empty = z.object({}).strict();
const CENTS = 'All amounts are integer cents.';

const entry = <T extends z.ZodType>(name: string, description: string, schema: T, run: (deps: Deps, q: z.output<T>, today: string, ctx: ToolContext) => unknown,
  input_schema = jsonSchema(schema)): [string, Entry] =>
  [name, { def: { name, description, input_schema }, schema, run: run as Entry['run'] }];

const MONEY: [string, Entry][] = [
  entry('spending', 'Money in, out and net for a month or year, with spending by category (out is spending, refunds reduce it); same numbers as the Spending tab.', SpendingQuery,
    (d, q) => getSpending(d.db, q), {
      type: 'object', properties: { period: { type: 'string', enum: ['month', 'year'] }, date: { type: 'string', description: 'YYYY-MM for a month, YYYY for a year' } },
      required: ['period', 'date'], additionalProperties: false,
    }),
  entry('expenses', 'The rows behind a month or year of spending (kind out) or income (kind in), each split line its own row, optionally for one category; pages with cursor.', ExpensesQuery,
    (d, q) => getExpenses(d.db, q)),
  entry('transactions', 'Bank transactions newest first (amount negative is money out), filtered by account, category, person, dates or text; pages with cursor.', ListTransactionsQuery,
    (d, q, today) => listTransactions(d.db, q, today)),
  entry('transaction', 'One transaction in full, with its split lines, person and notes.', z.object({ id: z.string().min(1) }).strict(),
    (d, q, today) => getTransaction(d.db, q.id, today)),
  entry('payee_history', "One payee's or one bill's spending by month with its rows and totals; same numbers as the payee History screen (give name or recurringId).", PayeeHistoryQuery,
    (d, q, today) => getPayeeHistory(d.db, q, today)),
  entry('bills', 'Recurring bills and subscriptions: upcoming charges, the monthly total and what is due this week.', z.object({ includeHidden: z.boolean().optional() }).strict(),
    (d, q, today) => getRecurring(d.db, today, q.includeHidden === true)),
  entry('reimbursements', 'Reimbursement money out and back in per month, with the unpaid amount and the rows.', Empty, (d, _q, today) => getReimbursements(d.db, today)),
  entry('people', 'People the owner shares money with and each running balance (positive: they owe the owner); give id for one person with their history.', z.object({ id: z.string().min(1).optional() }).strict(),
    (d, q) => (q.id ? getPerson(d.db, q.id) : listPeople(d.db, true))),
  entry('open_items', 'Charges each person still owes the owner for, oldest first, with what is left and the paybacks linked to each; give personId for one person.',
    z.object({ personId: z.string().min(1).optional() }).strict(),
    (d, q) => {
      const receipts = receiptIds(d.db);
      return listPeople(d.db, true).filter((p) => !q.personId || p.id === q.personId)
        .map((p) => ({ personId: p.id, name: p.name, items: openItems(settlePerson(d.db, p.id), receipts) }))
        .filter((p) => p.items.length);
    }),
  entry('net_worth', 'Daily net worth history over a range with the current value and the change, hidden accounts left out; give accountIds (from accounts) and/or type for those accounts\' daily balance alone, e.g. to find which account moved.',
    NetWorthQuery.extend({ accountIds: z.array(z.string().min(1)).min(1).max(50).optional(), type: z.enum(['depository', 'credit', 'loan', 'investment', 'other']).optional() }).strict(),
    (d, { range, ...filter }, today) => getNetWorth(d.db, range, today, filter)),
  entry('investments', 'Investment holdings with value, cost basis and gain; give holding (a holding key) for that holding\'s value history over range (default 1y).',
    z.object({ holding: z.string().min(1).optional(), range: Range.optional() }).strict(),
    (d, q, today) => (q.holding ? getHoldingHistory(d.db, q.holding, q.range ?? '1y', today) : getInvestments(d.db))),
  entry('accounts', 'Bank, card and investment accounts with current balances.', Empty, (d) => listAccounts(d.db)),
  entry('categories', 'The spending and income categories transactions can have.', Empty, (d) => listCategories(d.db)),
];
// a message too long for one result is cut to this many JSON characters, so read_chat drops old messages, never the newest
const MESSAGE_MAX = 15_000;
const clip = (text: string): string => {
  let n = text.length;
  while (JSON.stringify(text.slice(0, n)).length > MESSAGE_MAX) n = Math.floor(n * 0.8);
  return n < text.length ? `${text.slice(0, n)}… [message cut]` : text;
};

const ENTRIES = new Map<string, Entry>([
  ...MONEY.map(([name, e]): [string, Entry] => [name, { ...e, def: { ...e.def, description: `${e.def.description} ${CENTS}` } }]),
  entry('search_chats', "Searches the owner's own earlier conversations with you (questions and your answers) for messages containing every word of query, optionally between from and to; returns each match's chatId, title, date and a snippet with the words in [brackets]. Without query (e.g. for \"our last chat\"), lists the most recently active chats newest first, each with its first question as the snippet and that question's date (from and to then apply to that date).",
    z.object({ query: z.string().max(200).regex(/[\p{L}\p{N}]/u, 'query has no words to search for').optional(), from: Day, to: Day, limit: z.number().int().min(1).max(20).optional() }).strict(),
    (d, q, _today, ctx) => searchChats(d.db, { ...q, limit: q.limit ?? 10 }, ctx.chatId)),
  entry('read_chat', "One of the owner's own earlier conversations with you in full (id is a chatId from search_chats): each message's role, date and text.",
    z.object({ id: z.string().min(1) }).strict(), (d, q) => {
      const chat = getChat(d.db, q.id);
      return chat && { id: chat.id, title: chat.title, createdAt: chat.createdAt,
        messages: chat.messages.map((m) => ({ role: m.role, date: localDay(new Date(m.createdAt)), text: clip(m.text) })) };
    }),
  entry('show_chart', 'Shows the owner a bar or line chart above your answer, at most 2 per answer. Every value must come from a tool result in this conversation. For unit usd_cents values are integer cents; for unit percent values are percentage points (12.5 = 12.5%).',
    z.object({ kind: z.enum(['bar', 'line']), title: z.string().min(1).max(60), unit: z.enum(['usd_cents', 'count', 'percent']),
      points: z.array(z.object({ label: z.string().min(1).max(24), value: z.number() }).strict()).min(2).max(31) }).strict()
      .refine((c) => c.unit !== 'usd_cents' || c.points.every((p) => Number.isInteger(p.value)), { message: 'usd_cents values must be integer cents', path: ['points'] }),
    () => ({ shown: true })),
]);

export const TOOLS: ToolDef[] = [...ENTRIES.values()].map((e) => e.def);

const ARRAY_KEYS = ['transactions', 'rows', 'items', 'points', 'holdings', 'history', 'messages', 'results'];
const TEXT_KEYS = new Set(['notes', 'name', 'payee', 'bankDescription', 'merchantName', 'matchText']);


const shorten = (v: unknown, cap: number): unknown => (Array.isArray(v) ? v.map((x) => shorten(x, cap))
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) =>
    [k, TEXT_KEYS.has(k) && typeof x === 'string' && x.length > cap ? `${x.slice(0, cap)}…` : shorten(x, cap)]))
    : v);

/** Fits a result under RESULT_MAX. Paged results are re-run with a smaller limit so nextCursor stays the function's own, then long text is
 * shortened; a page never drops rows (nextCursor points past them). Other arrays are trimmed, largest first; points (oldest first) keep the newest. */
function fit(e: Entry, deps: Deps, input: Record<string, unknown>, today: string, ctx: ToolContext, result: unknown): string {
  let s = JSON.stringify(result);
  if (s.length <= RESULT_MAX) return s;
  const NOTE = { truncated: true, note: e.def.name === 'read_chat' ? 'Oldest messages left out.' : 'Result cut; narrow the dates or filters.' };
  let out = result;
  let limit = typeof input.limit === 'number' ? input.limit : 0;
  while (s.length > RESULT_MAX && limit > 1) {
    limit = Math.floor(limit * 0.8);
    out = e.run(deps, { ...input, limit }, today, ctx);
    s = JSON.stringify({ ...(out as object), ...NOTE });
  }
  if (out && typeof out === 'object' && !Array.isArray(out)) {
    let obj: Record<string, unknown> = { ...(out as Record<string, unknown>), ...NOTE };
    s = JSON.stringify(obj);
    for (const cap of [500, 100]) if (s.length > RESULT_MAX) { obj = shorten(obj, cap) as typeof obj; s = JSON.stringify(obj); }
    const arrays = () => ('nextCursor' in obj ? [] : ARRAY_KEYS.filter((k) => Array.isArray(obj[k]) && (obj[k] as unknown[]).length));
    while (s.length > RESULT_MAX && arrays().length) {
      const k = arrays().sort((x, y) => (obj[y] as unknown[]).length - (obj[x] as unknown[]).length)[0]!;
      const a = obj[k] as unknown[];
      const n = Math.floor(a.length * 0.8);
      obj[k] = k === 'points' || k === 'messages' ? a.slice(a.length - n) : a.slice(0, n);
      s = JSON.stringify(obj);
    }
    if (s.length <= RESULT_MAX) return s;
  }
  let n = RESULT_MAX;
  const raw = JSON.stringify(out);
  do { n = Math.floor(n * 0.8); s = JSON.stringify({ truncated: true, partial: raw.slice(0, n) }); } while (s.length > RESULT_MAX);
  return s;
}

export function runTool(deps: Deps, name: string, input: unknown, ctx: ToolContext = {}): { content: string; isError: boolean } {
  const fail = (error: string) => ({ content: JSON.stringify({ error }), isError: true });
  const e = ENTRIES.get(name);
  if (!e) return fail(`unknown tool ${name}`);
  const parsed = e.schema.safeParse(input ?? {});
  if (!parsed.success) return fail(z.prettifyError(parsed.error));
  try {
    const today = localDay(deps.now());
    const result = e.run(deps, parsed.data, today, ctx);
    return result == null ? fail('not found') : { content: fit(e, deps, parsed.data as Record<string, unknown>, today, ctx, result), isError: false };
  } catch (err) {
    return fail(err instanceof ApiError ? err.message : 'tool failed');
  }
}
