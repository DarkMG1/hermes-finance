import { z } from 'zod';
import { ExpensesQuery, ListTransactionsQuery, NetWorthQuery, PayeeHistoryQuery, SpendingQuery } from '@hermes/shared';
import type { Deps } from '../deps.ts';
import { ApiError } from '../errors.ts';
import { getExpenses, getPayeeHistory, getReimbursements, getSpending } from '../cashflow.ts';
import { getTransaction, listAccounts, listCategories, listTransactions } from '../ledger.ts';
import { getRecurring } from '../recurring.ts';
import { getPerson, listPeople } from '../people.ts';
import { getNetWorth, localDay } from '../networth.ts';
import { getHoldingHistory, getInvestments } from '../investments.ts';

export type ToolDef = { name: string; description: string; input_schema: Record<string, unknown> };
export const RESULT_MAX = 20_000;

type Entry = { def: ToolDef; schema: z.ZodType; run: (deps: Deps, q: unknown, today: string) => unknown };

const jsonSchema = (s: z.ZodType): Record<string, unknown> => {
  const out: Record<string, unknown> = z.toJSONSchema(s, { io: 'input' });
  delete out.$schema;
  return out;
};
const Range = NetWorthQuery.shape.range;
const Empty = z.object({}).strict();
const CENTS = 'All amounts are integer cents.';

const entry = <T extends z.ZodType>(name: string, description: string, schema: T, run: (deps: Deps, q: z.output<T>, today: string) => unknown,
  input_schema = jsonSchema(schema)): [string, Entry] =>
  [name, { def: { name, description: `${description} ${CENTS}`, input_schema }, schema, run: run as Entry['run'] }];

const ENTRIES = new Map<string, Entry>([
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
    (d, q) => (q.id ? getPerson(d.db, q.id) : listPeople(d.db, false))),
  entry('net_worth', 'Daily net worth history over a range with the current value and the change.', NetWorthQuery, (d, q, today) => getNetWorth(d.db, q.range, today)),
  entry('investments', 'Investment holdings with value, cost basis and gain; give holding (a holding key) for that holding\'s value history over range (default 1y).',
    z.object({ holding: z.string().min(1).optional(), range: Range.optional() }).strict(),
    (d, q, today) => (q.holding ? getHoldingHistory(d.db, q.holding, q.range ?? '1y', today) : getInvestments(d.db))),
  entry('accounts', 'Bank, card and investment accounts with current balances.', Empty, (d) => listAccounts(d.db)),
  entry('categories', 'The spending and income categories transactions can have.', Empty, (d) => listCategories(d.db)),
]);

export const TOOLS: ToolDef[] = [...ENTRIES.values()].map((e) => e.def);

const ARRAY_KEYS = ['transactions', 'rows', 'items', 'points', 'holdings'];

const NOTE = { truncated: true, note: 'Result cut; narrow the dates or filters.' };

/** Fits a result under RESULT_MAX. Paged results are re-run with a smaller limit so nextCursor stays the function's own; other arrays are trimmed, largest first. */
function fit(e: Entry, deps: Deps, input: Record<string, unknown>, today: string, result: unknown): string {
  let s = JSON.stringify(result);
  if (s.length <= RESULT_MAX) return s;
  let out = result;
  let limit = typeof input.limit === 'number' ? input.limit : 0;
  while (s.length > RESULT_MAX && limit > 1) {
    limit = Math.floor(limit * 0.8);
    out = e.run(deps, { ...input, limit }, today);
    s = JSON.stringify({ ...(out as object), ...NOTE });
  }
  if (out && typeof out === 'object' && !Array.isArray(out)) {
    const obj: Record<string, unknown> = { ...(out as Record<string, unknown>), ...NOTE };
    const arrays = () => ARRAY_KEYS.filter((k) => Array.isArray(obj[k]) && (obj[k] as unknown[]).length);
    s = JSON.stringify(obj);
    while (s.length > RESULT_MAX && arrays().length) {
      const k = arrays().sort((x, y) => (obj[y] as unknown[]).length - (obj[x] as unknown[]).length)[0]!;
      obj[k] = (obj[k] as unknown[]).slice(0, Math.floor((obj[k] as unknown[]).length * 0.8));
      s = JSON.stringify(obj);
    }
    if (s.length <= RESULT_MAX) return s;
  }
  let n = RESULT_MAX;
  const raw = JSON.stringify(out);
  do { n = Math.floor(n * 0.8); s = JSON.stringify({ truncated: true, partial: raw.slice(0, n) }); } while (s.length > RESULT_MAX);
  return s;
}

export function runTool(deps: Deps, name: string, input: unknown): { content: string; isError: boolean } {
  const fail = (error: string) => ({ content: JSON.stringify({ error }), isError: true });
  const e = ENTRIES.get(name);
  if (!e) return fail(`unknown tool ${name}`);
  const parsed = e.schema.safeParse(input ?? {});
  if (!parsed.success) return fail(z.prettifyError(parsed.error));
  try {
    const today = localDay(deps.now());
    const result = e.run(deps, parsed.data, today);
    return result == null ? fail('not found') : { content: fit(e, deps, parsed.data as Record<string, unknown>, today, result), isError: false };
  } catch (err) {
    return fail(err instanceof ApiError ? err.message : 'tool failed');
  }
}

const LABELS: Record<string, string> = {
  spending: 'Spending', expenses: 'Expenses', transactions: 'Transactions', transaction: 'Transaction', payee_history: 'Payee history', bills: 'Bills',
  reimbursements: 'Reimbursements', people: 'People', net_worth: 'Net worth', investments: 'Investments', accounts: 'Accounts', categories: 'Categories',
};

export function toolLabel(name: string, input: Record<string, unknown>): string {
  const span = input.from || input.to ? `${input.from ?? ''} – ${input.to ?? ''}` : undefined;
  const detail = [span, input.date ?? input.month, input.name, input.range].find((v) => typeof v === 'string');
  return `${LABELS[name] ?? name}${detail ? ` · ${detail}` : ''}`;
}
