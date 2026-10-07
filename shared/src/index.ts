import { z } from 'zod';

export const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const Id = z.string().min(1).max(100);
const DateStr = z.string().regex(DATE_RE, 'expected YYYY-MM-DD');
const Cents = z.number().int().safe();

export const ApiErrorBody = z.object({ code: z.string(), message: z.string(), field: z.string().optional() });
export type ApiErrorBody = z.infer<typeof ApiErrorBody>;

export const Account = z.object({
  id: Id, name: z.string(), mask: z.string().nullable(), type: z.string(), subtype: z.string().nullable(),
  balanceCurrentCents: Cents.nullable(), balanceAvailableCents: Cents.nullable(), balanceAt: z.string().nullable(),
  hidden: z.boolean(), itemId: Id.nullable(),
});
export type Account = z.infer<typeof Account>;

export const Category = z.object({
  id: Id, name: z.string(), groupName: z.string(), isIncome: z.boolean(), isTransfer: z.boolean(), hidden: z.boolean(),
});
export type Category = z.infer<typeof Category>;

export const SplitLine = z.object({ id: Id, amountCents: Cents, categoryId: Id.nullable(), notes: z.string().nullable() });
export type SplitLine = z.infer<typeof SplitLine>;

export const Transaction = z.object({
  id: Id, accountId: Id, source: z.enum(['plaid', 'manual', 'actual']), date: DateStr,
  amountCents: Cents, payee: z.string(), bankDescription: z.string(), merchantName: z.string().nullable(),
  pending: z.boolean(), categoryId: Id.nullable(), notes: z.string().nullable(), splitLines: z.array(SplitLine),
});
export type Transaction = z.infer<typeof Transaction>;

export const TransactionPage = z.object({ transactions: z.array(Transaction), nextCursor: z.string().nullable() });
export type TransactionPage = z.infer<typeof TransactionPage>;

export const ListTransactionsQuery = z.object({
  accountId: Id.optional(), categoryId: Id.optional(), from: DateStr.optional(), to: DateStr.optional(),
  q: z.string().min(1).max(100).optional(), cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
}).strict();
export type ListTransactionsQuery = z.infer<typeof ListTransactionsQuery>;

export const PatchTransactionBody = z.object({
  categoryId: Id.nullable().optional(), payee: z.string().max(200).nullable().optional(), notes: z.string().max(2000).nullable().optional(),
}).strict().refine((b) => Object.keys(b).length > 0, { message: 'at least one field is required' });
export type PatchTransactionBody = z.infer<typeof PatchTransactionBody>;

export const CreateTransactionBody = z.object({
  accountId: Id, date: DateStr, amountCents: Cents.refine((n) => n !== 0, 'amount must not be zero'),
  payee: z.string().min(1).max(200), categoryId: Id.nullable().optional(), notes: z.string().max(2000).nullable().optional(),
}).strict();
export type CreateTransactionBody = z.infer<typeof CreateTransactionBody>;

export const Home = z.object({
  netWorthCents: Cents, recent: z.array(Transaction),
  reconnect: z.array(z.object({ itemId: Id, institutionName: z.string() })),
});
export type Home = z.infer<typeof Home>;

export const SpendingQuery = z.discriminatedUnion('period', [
  z.object({ period: z.literal('month'), date: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) }),
  z.object({ period: z.literal('year'), date: z.string().regex(/^\d{4}$/) }),
]);
export type SpendingQuery = z.infer<typeof SpendingQuery>;

export const Spending = z.object({
  from: DateStr, toExclusive: DateStr, totalCents: Cents,
  categories: z.array(z.object({ categoryId: Id.nullable(), name: z.string(), spentCents: Cents })),
});
export type Spending = z.infer<typeof Spending>;

export const Bank = z.object({
  itemId: Id, institutionName: z.string(), status: z.enum(['ok', 'login_required', 'error']),
  lastSyncedAt: z.string().nullable(), lastErrorCode: z.string().nullable(),
});
export type Bank = z.infer<typeof Bank>;

export const CreateLinkSessionBody = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('create') }).strict(),
  z.object({ mode: z.literal('update'), itemId: Id }).strict(),
]);
export type CreateLinkSessionBody = z.infer<typeof CreateLinkSessionBody>;

export const LinkSession = z.object({ sessionId: Id, url: z.string().url(), expiresAt: z.string() });
export type LinkSession = z.infer<typeof LinkSession>;

export const SyncStatus = z.object({
  items: z.array(z.object({
    itemId: Id, institutionName: z.string(), result: z.enum(['ok', 'login_required', 'error', 'already_running']),
    added: z.number().int(), modified: z.number().int(), removed: z.number().int(),
  })),
});
export type SyncStatus = z.infer<typeof SyncStatus>;
