import { z } from 'zod';

const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const Id = z.string().min(1).max(100);
const DateStr = z.string().regex(DATE_RE, 'expected YYYY-MM-DD')
  .refine((s) => DATE_RE.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s, 'not a real date');
// Leave year 9999 for exclusive period boundaries and derived dates in responses.
const DateInput = DateStr.refine((s) => s < '9999-01-01', 'year must be at most 9998');
const Cents = z.number().int().safe();
export const MAX_AMOUNT_CENTS = 1_000_000_000;
const LedgerCents = Cents.min(-MAX_AMOUNT_CENTS).max(MAX_AMOUNT_CENTS);

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

export const SplitLine = z.object({
  id: Id, amountCents: Cents, categoryId: Id.nullable(), notes: z.string().nullable(), personId: Id.nullable(), payee: z.string().nullable(),
});
export type SplitLine = z.infer<typeof SplitLine>;

export const RecurringFrequency = z.enum(['weekly', 'biweekly', 'semi_monthly', 'monthly', 'annually', 'unknown']);

const PaidBack = z.object({ transactionId: Id, lineId: Id.nullable(), amountCents: Cents });

export const Transaction = z.object({
  id: Id, accountId: Id, source: z.enum(['plaid', 'manual', 'actual', 'applecard']), date: DateStr,
  /** The bank's own date, even under an owner-set date; null on manual and Actual rows and on rows the owner re-dated before 2.1.1. */
  bankDate: DateStr.nullable(),
  amountCents: Cents, payee: z.string(), bankDescription: z.string(), merchantName: z.string().nullable(),
  pending: z.boolean(), categoryId: Id.nullable(), notes: z.string().nullable(), personId: Id.nullable(), paidByPersonId: Id.nullable(), repaymentDismissed: z.boolean(), splitLines: z.array(SplitLine),
  /** Marked reconciled and the bank amount unchanged since. */
  reconciled: z.boolean(),
  hasReceipt: z.boolean(),
  forgiven: z.boolean(),
  /** The payee has a History to open: a name to match, not an unsplit IOU, and not only the bank's raw text. */
  hasHistory: z.boolean(),
  /** The visible Recurring item this charge belongs to (ended ones too). */
  recurring: z.object({ id: z.string(), name: z.string(), frequency: RecurringFrequency }).nullable(),
  /** Unsplit person-tagged rows: an item's leftCents (null on a payback) and what a payback paid. */
  iou: z.object({ leftCents: Cents.nullable(), paidBack: z.array(PaidBack.extend({ payee: z.string() })) }).nullable(),
  /** The pay stub linked to this deposit; only its id, so its figures stay behind Face ID (GET /v1/pay-stubs/:id). */
  payStub: z.object({ id: Id }).nullable().optional(),
});
export type Transaction = z.infer<typeof Transaction>;

export const TransactionPage = z.object({ transactions: z.array(Transaction), nextCursor: z.string().nullable() });
export type TransactionPage = z.infer<typeof TransactionPage>;

export const ListTransactionsQuery = z.object({
  accountId: Id.optional(), categoryId: Id.optional(), personId: Id.optional(), from: DateInput.optional(), to: DateInput.optional(),
  q: z.string().min(1).max(100).optional(), cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
}).strict();
export type ListTransactionsQuery = z.infer<typeof ListTransactionsQuery>;

export const PatchTransactionBody = z.object({
  categoryId: Id.nullable().optional(), payee: z.string().min(1).max(200).nullable().optional(), notes: z.string().max(2000).nullable().optional(),
  personId: Id.nullable().optional(), paidByPersonId: Id.nullable().optional(), repaymentDismissed: z.boolean().optional(),
  /** The owner's date; bank sync and Apple Card re-import keep it from then on. null: back to the bank's date. */
  date: DateInput.nullable().optional(),
}).strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'at least one field is required' })
  .refine((b) => !(b.categoryId && b.personId), { message: 'categoryId and personId cannot both be set', path: ['personId'] })
  .refine((b) => !(b.personId && b.paidByPersonId), { message: 'a row someone else paid is your own spending', path: ['personId'] });
export type PatchTransactionBody = z.infer<typeof PatchTransactionBody>;

export const PatchAccountBody = z.object({ name: z.string().trim().min(1).max(100).nullable() }).strict();
export type PatchAccountBody = z.infer<typeof PatchAccountBody>;

/** Replaces a transaction's split lines. No lines removes the split; otherwise 2+ lines that add up to the transaction amount.
 * Send personId and payee explicitly (null to clear); omitting either on an annotated split returns APP_OUTDATED. */
export const PutSplitsBody = z.object({
  lines: z.array(z.object({
    /** A current line of this transaction: its IOU links stay on this line. Absent on new lines and from older apps. */
    id: Id.optional(),
    amountCents: LedgerCents.refine((n) => n !== 0, 'amount must not be zero'), categoryId: Id.nullable(), notes: z.string().max(2000).nullable().optional(),
    personId: Id.nullable().optional(),
    /** The line's own name; blank or missing shows the transaction's payee. */
    payee: z.string().trim().max(200).nullable().optional(),
  }).strict().refine((l) => !(l.categoryId && l.personId), { message: 'a line with a person has no category', path: ['personId'] }))
    .max(20).refine((l) => l.length !== 1, 'a split needs at least two lines'),
}).strict();
export type PutSplitsBody = z.infer<typeof PutSplitsBody>;

/** Changes one split line in place. A person clears the line's category and a category clears its person. */
export const PatchSplitLineBody = z.object({
  payee: z.string().trim().max(200).nullable().optional(), categoryId: Id.nullable().optional(),
  personId: Id.nullable().optional(), notes: z.string().max(2000).nullable().optional(),
}).strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'at least one field is required' })
  .refine((b) => !(b.categoryId && b.personId), { message: 'a line with a person has no category', path: ['personId'] });
export type PatchSplitLineBody = z.infer<typeof PatchSplitLineBody>;

export const Person = z.object({ id: Id, name: z.string(), matchText: z.string().nullable(), archived: z.boolean(), balanceCents: Cents });
export type Person = z.infer<typeof Person>;

export const HistoryEntry = z.object({
  transactionId: Id, lineId: Id.nullable(), date: DateStr, payee: z.string(), kind: z.enum(['forThem', 'fromThem', 'paidByThem', 'forgiven']),
  effectCents: Cents, balanceAfterCents: Cents, settled: z.boolean(), hasReceipt: z.boolean(),
  /** Items only. */
  leftCents: Cents.optional(),
  /** Paybacks with links only. */
  paidBack: z.array(PaidBack).optional(),
});
export type HistoryEntry = z.infer<typeof HistoryEntry>;

/** A charge for a person that isn't fully paid back yet; paybacks are the ones linked to it. */
export const OpenItem = z.object({
  transactionId: Id, lineId: Id.nullable(), date: DateStr, payee: z.string(), totalCents: Cents, leftCents: Cents, hasReceipt: z.boolean(),
  paybacks: z.array(z.object({ transactionId: Id, lineId: Id.nullable(), date: DateStr, amountCents: Cents })),
});
export type OpenItem = z.infer<typeof OpenItem>;

export const PersonDetail = z.object({ person: Person, history: z.array(HistoryEntry), spentOnThemCents: Cents, forgivenCents: Cents, openItems: z.array(OpenItem) });
export type PersonDetail = z.infer<typeof PersonDetail>;

export const ReimbursementsCleanup = z.object({ rows: z.array(z.object({ transaction: Transaction, lineId: Id.nullable() })) });
export type ReimbursementsCleanup = z.infer<typeof ReimbursementsCleanup>;

export const PaybackQuery = z.object({ personId: Id, lineId: Id.optional() }).strict();
export const PaybackBody = z.object({
  personId: Id, lineId: Id.nullable().optional(),
  items: z.array(z.object({ transactionId: Id, lineId: Id.nullable().optional(), amountCents: z.number().int().min(1).max(MAX_AMOUNT_CENTS) }).strict()).max(200),
}).strict();
export type PaybackBody = z.infer<typeof PaybackBody>;
export const PaybackChoices = z.object({ items: z.array(OpenItem), linked: z.array(PaidBack) });
export type PaybackChoices = z.infer<typeof PaybackChoices>;

export const ForgiveBody = z.object({
  amountCents: z.number().int().min(1).max(10_000_000), date: DateInput, categoryId: Id.nullable().optional(), notes: z.string().max(2000).optional(),
}).strict();
export type ForgiveBody = z.infer<typeof ForgiveBody>;

export const RepaymentSuggestion = z.object({ transaction: Transaction, personId: Id.nullable() });
export type RepaymentSuggestion = z.infer<typeof RepaymentSuggestion>;

export const ListPeopleQuery = z.object({ all: z.enum(['0', '1']).optional() }).strict();
export type ListPeopleQuery = z.infer<typeof ListPeopleQuery>;

export const CreatePersonBody = z.object({
  name: z.string().trim().min(1).max(100), matchText: z.string().trim().min(1).max(200).nullable().optional(),
}).strict();
export type CreatePersonBody = z.infer<typeof CreatePersonBody>;

export const PatchPersonBody = z.object({
  name: z.string().trim().min(1).max(100).optional(), matchText: z.string().trim().min(1).max(200).nullable().optional(),
  archived: z.boolean().optional(),
}).strict().refine((b) => Object.keys(b).length > 0, { message: 'at least one field is required' });
export type PatchPersonBody = z.infer<typeof PatchPersonBody>;

/** Where repayments land. null: every checking account. */
export const PeopleSettings = z.object({ repaymentAccountId: Id.nullable() }).strict();
export type PeopleSettings = z.infer<typeof PeopleSettings>;

export const CreateTransactionBody = z.object({
  date: DateInput, amountCents: LedgerCents.refine((n) => n !== 0, 'amount must not be zero'),
  payee: z.string().min(1).max(200), categoryId: Id.nullable().optional(), notes: z.string().max(2000).nullable().optional(),
  paidByPersonId: Id.optional(),
  /** Links a waiting receipt in the same write as its Paid-by transaction. */
  inboxReceiptId: Id.optional(),
  /** All of it is this person's: they owe the owner the whole amount. */
  personId: Id.optional(),
  /** Saved already split: the row and its lines are written together. */
  splitLines: PutSplitsBody.shape.lines.optional(),
}).strict()
  .refine((b) => !b.paidByPersonId || b.amountCents < 0, { message: 'a payer covers money out', path: ['paidByPersonId'] })
  .refine((b) => !b.inboxReceiptId || !!b.paidByPersonId, { message: 'an inbox receipt requires a payer', path: ['inboxReceiptId'] })
  .refine((b) => !(b.splitLines?.length && b.paidByPersonId), { message: 'a transaction someone else paid cannot be split', path: ['splitLines'] })
  .refine((b) => !(b.splitLines?.length && b.categoryId), { message: "a split's category lives on its lines", path: ['categoryId'] })
  .refine((b) => !(b.personId && (b.paidByPersonId || b.categoryId || b.splitLines?.length)), {
    message: 'a row for a person has no payer, category or split', path: ['personId'],
  });
export type CreateTransactionBody = z.infer<typeof CreateTransactionBody>;

const Month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'expected YYYY-MM');
const MonthInput = Month.refine((s) => s < '9999-01', 'year must be at most 9998');

export const ReconcileSummary = z.object({ month: Month, open: z.number().int() });
export type ReconcileSummary = z.infer<typeof ReconcileSummary>;

export const Home = z.object({
  netWorthCents: Cents, recent: z.array(Transaction),
  owedToYouCents: Cents, youOweCents: Cents, repaymentSuggestions: z.number().int(),
  toReconcile: ReconcileSummary.nullable(),
  reconnect: z.array(z.object({ itemId: Id, institutionName: z.string() })),
});
export type Home = z.infer<typeof Home>;

export const ReconcileQuery = z.object({ month: MonthInput }).strict();
export type ReconcileQuery = z.infer<typeof ReconcileQuery>;

/** One month's money-out rows: how many need reconciling, how many are still open, and the open ones oldest first. */
export const Reconcile = z.object({ month: Month, total: z.number().int(), open: z.number().int(), transactions: z.array(Transaction) });
export type Reconcile = z.infer<typeof Reconcile>;

export const ReconcileMonths = z.object({ months: z.array(ReconcileSummary) });
export type ReconcileMonths = z.infer<typeof ReconcileMonths>;

export const ReconcileBody = z.object({ reconciled: z.boolean(), amountCents: Cents.optional() }).strict();
export type ReconcileBody = z.infer<typeof ReconcileBody>;

export const SpendingQuery = z.discriminatedUnion('period', [
  z.object({ period: z.literal('month'), date: MonthInput }),
  z.object({ period: z.literal('year'), date: z.string().regex(/^\d{4}$/).refine((s) => s < '9999', 'year must be at most 9998') }),
]);
export type SpendingQuery = z.infer<typeof SpendingQuery>;

export const Spending = z.object({
  from: DateStr, toExclusive: DateStr, inCents: Cents, outCents: Cents, netCents: Cents,
  /** Equal to outCents; kept for app builds before v1.3. */
  totalCents: Cents,
  categories: z.array(z.object({ categoryId: Id.nullable(), name: z.string(), spentCents: Cents })),
});
export type Spending = z.infer<typeof Spending>;

export const NetWorthQuery = z.object({ range: z.enum(['1m', '3m', '1y', 'all']) }).strict();
export type NetWorthQuery = z.infer<typeof NetWorthQuery>;

const AccountIdsParam = z.string().max(4000).optional();
export const InvestmentsQuery = z.object({ accountIds: AccountIdsParam }).strict();
export type InvestmentsQuery = z.infer<typeof InvestmentsQuery>;
export const InvestmentsHistoryQuery = NetWorthQuery.extend({ accountIds: AccountIdsParam }).strict();
export const HoldingHistoryQuery = z.object({ key: z.string().min(1), range: NetWorthQuery.shape.range, accountIds: AccountIdsParam }).strict();
export type HoldingHistoryQuery = z.infer<typeof HoldingHistoryQuery>;

/** Daily history; each account's latest snapshot carries forward. Unpriced holding estimates are omitted.
 * Before an account's first snapshot its value is estimated; estimatedThrough is the last such day shown, or null.
 * excluded describes the last shown estimate that omits unpriced positions (counted per account/security). */
export const NetWorthHistory = z.object({
  points: z.array(z.object({ date: DateStr, netWorthCents: Cents })),
  currentCents: Cents, changeCents: Cents, estimatedThrough: DateStr.nullable(),
  excluded: z.object({ through: DateStr, positions: z.number().int().positive() }).optional(),
});
export type NetWorthHistory = z.infer<typeof NetWorthHistory>;

export const HoldingAccount = z.object({ accountId: Id, accountName: z.string(), quantity: z.number(), valueCents: Cents, costBasisCents: Cents.nullable() });
export type HoldingAccount = z.infer<typeof HoldingAccount>;

/** One holding combined across accounts by ticker (or Plaid security id); all cash is one holding keyed "_cash". */
export const Holding = z.object({
  key: z.string().min(1), name: z.string(), ticker: z.string().nullable(), type: z.string().nullable(), quantity: z.number(),
  priceCents: Cents.nullable(), valueCents: Cents, costBasisCents: Cents.nullable(), gainCents: Cents.nullable(), accounts: z.array(HoldingAccount),
});
export type Holding = z.infer<typeof Holding>;

export const Investments = z.object({
  totalCents: Cents, costBasisCents: Cents.nullable(), gainCents: Cents.nullable(), asOf: z.string().nullable(),
  holdings: z.array(Holding), reconnect: z.array(z.object({ itemId: Id, institutionName: z.string() })),
});
export type Investments = z.infer<typeof Investments>;

/** The rows behind a Spending number. categoryId 'uncategorized' selects the Uncategorized bucket. */
export const ExpensesQuery = z.object({
  period: z.enum(['month', 'year']), date: z.string(), kind: z.enum(['out', 'in']).default('out'),
  categoryId: Id.optional(), cursor: z.string().max(400).optional(), limit: z.coerce.number().int().min(1).max(200).default(50),
}).strict()
  .refine((q) => SpendingQuery.safeParse({ period: q.period, date: q.date }).success, { message: 'date does not match period', path: ['date'] });
export type ExpensesQuery = z.infer<typeof ExpensesQuery>;

export const ExpenseRow = z.object({
  transactionId: Id, lineId: Id.nullable(), date: DateStr, name: z.string(), categoryId: Id.nullable(), categoryName: z.string(),
  /** Out: spending is positive and a refund negative. In: income is positive. */
  amountCents: Cents, isSplit: z.boolean(), isSplitDifference: z.boolean(), pending: z.boolean(),
});
export type ExpenseRow = z.infer<typeof ExpenseRow>;

export const ExpensesPage = z.object({ rows: z.array(ExpenseRow), nextCursor: z.string().nullable() });
export type ExpensesPage = z.infer<typeof ExpensesPage>;
/** One payee's spending, or one recurring bill's. name is matched after normalizing (case, store numbers, punctuation), as a whole-word prefix;
 * bank (with name) also matches charges not renamed from that exact bank text; month (YYYY-MM) narrows the rows only, never the months or totals. */
export const PayeeHistoryQuery = z.object({
  name: z.string().min(1).max(2000).optional(), bank: z.string().min(1).max(2000).optional(), recurringId: Id.optional(),
  month: MonthInput.optional(),
  cursor: z.string().max(400).optional(), limit: z.coerce.number().int().min(1).max(200).default(50),
}).strict()
  .refine((q) => (q.name === undefined) !== (q.recurringId === undefined), { message: 'give name or recurringId', path: ['name'] })
  .refine((q) => q.bank === undefined || q.name !== undefined, { message: 'bank goes with name', path: ['bank'] });
export type PayeeHistoryQuery = z.infer<typeof PayeeHistoryQuery>;
export const PayeeMonth = z.object({ month: z.string(), cents: Cents });
export type PayeeMonth = z.infer<typeof PayeeMonth>;
/** shareCents: the owner's part, spending positive; totalCents: the whole charge, only when the charge itself matched and is split; upcoming: dated
 * after today; reimbursed: in the Reimbursement category. */
export const PayeeHistoryRow = z.object({
  transactionId: Id, date: DateStr, name: z.string(), shareCents: Cents, totalCents: Cents.nullable(), upcoming: z.boolean(), reimbursed: z.boolean(), pending: z.boolean(),
});
export type PayeeHistoryRow = z.infer<typeof PayeeHistoryRow>;
/** names: payee mode only, every other name its rows matched (first-seen spelling) and whether the owner left it out; excluded rows aren't counted. */
export const PayeeHistory = z.object({
  name: z.string(), months: z.array(PayeeMonth), totalCents: Cents, averageCents: Cents, rows: z.array(PayeeHistoryRow), nextCursor: z.string().nullable(),
  names: z.array(z.object({ name: z.string(), excluded: z.boolean() })),
});
export type PayeeHistory = z.infer<typeof PayeeHistory>;
/** Leaves a longer name out of a payee's History (excluded: false puts it back). */
export const HistoryExclusionBody = z.object({ name: z.string().min(1).max(2000), excludedName: z.string().min(1).max(2000), excluded: z.boolean() }).strict();
export type HistoryExclusionBody = z.infer<typeof HistoryExclusionBody>;

/** The last 12 months of Reimbursement lines, newest first: charges out, paybacks in, and what's still unpaid. amountCents is signed as stored. */
export const Reimbursements = z.object({
  months: z.array(z.object({ month: Month, outCents: Cents, inCents: Cents, unpaidCents: Cents })),
  rows: z.array(z.object({ transactionId: Id, lineId: Id.nullable(), date: DateStr, name: z.string(), amountCents: Cents })),
});
export type Reimbursements = z.infer<typeof Reimbursements>;

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

export const AppleCardImportBody = z.object({ csv: z.string().min(1).max(2_000_000) }).strict();
export type AppleCardImportBody = z.infer<typeof AppleCardImportBody>;

export const AppleCardImportResult = z.object({
  accountId: Id, rows: z.number().int(), added: z.number().int(), updated: z.number().int(), skippedBeforeCutover: z.number().int(),
});
export type AppleCardImportResult = z.infer<typeof AppleCardImportResult>;

const Extra = z.number().int().min(0).max(10_000_000);

/** What the receipt reader must return; zero-amount lines (free items) are dropped. */
export const ReceiptReadOutput = z.object({
  items: z.array(z.object({ name: z.string().trim().min(1).max(200), amountCents: z.number().int().min(-10_000_000).max(10_000_000) }))
    .transform((items) => items.filter((i) => i.amountCents !== 0))
    .refine((items) => items.length >= 1 && items.length <= 200, 'between 1 and 200 items'),
  taxCents: Extra, tipCents: Extra, feesCents: Extra,
  totalCents: z.number().int().min(0).max(100_000_000).nullable(),
  merchant: z.string().trim().max(200).nullable().optional().catch(null).transform((m) => (m ? m : null)),
  purchaseDate: DateInput.nullable().optional().catch(null).transform((d) => d ?? null),
});
export type ReceiptReadOutput = z.infer<typeof ReceiptReadOutput>;

export const ReceiptItem = z.object({ id: Id, name: z.string(), amountCents: Cents, people: z.array(z.string()) });
export type ReceiptItem = z.infer<typeof ReceiptItem>;

export const Itemization = z.object({
  items: z.array(ReceiptItem),
  taxCents: Cents.nullable(), tipCents: Cents.nullable(), feesCents: Cents.nullable(), totalCents: Cents.nullable(),
  readAt: z.string().nullable(),
  /** The split (or a "they paid" amount) changed since the items were last saved. */
  handEdited: z.boolean(),
});
export type Itemization = z.infer<typeof Itemization>;

export const SaveItemsBody = z.object({
  items: z.array(z.object({
    name: z.string().trim().min(1).max(200),
    amountCents: Cents.refine((n) => n !== 0 && Math.abs(n) <= 10_000_000, 'amount must be non-zero and at most 100,000.00'),
    people: z.array(Id).min(1).max(20).refine((p) => new Set(p).size === p.length, 'a person is listed twice'),
  }).strict()).min(1).max(200).refine((items) => new Set(items.flatMap((i) => i.people)).size <= 20, 'at most 20 people across all items'),
  taxCents: Extra, tipCents: Extra, feesCents: Extra,
}).strict();
export type SaveItemsBody = z.infer<typeof SaveItemsBody>;

export const InboxReceipt = z.object({
  id: Id, capturedAt: z.string(), status: z.enum(['reading', 'read', 'failed']),
  merchant: z.string().nullable(), purchaseDate: DateStr.nullable(), totalCents: Cents.nullable(), tagged: z.boolean(),
  /** the payee name already used for this store (Acme for "Acme Wholesale"), else merchant */
  payee: z.string().nullable(),
  forPersonId: Id.nullable().optional(),
  taggedPersonIds: z.array(Id).optional(),
  suggestions: z.array(Transaction),
});
export type InboxReceipt = z.infer<typeof InboxReceipt>;

export const LinkedReceipt = z.object({
  id: Id, transactionId: Id, merchant: z.string().nullable(), totalCents: Cents.nullable(), linkedAt: z.string(), splitApplied: z.boolean(),
});
export type LinkedReceipt = z.infer<typeof LinkedReceipt>;

export const InboxList = z.object({ waiting: z.array(InboxReceipt), recentlyLinked: z.array(LinkedReceipt) });
export type InboxList = z.infer<typeof InboxList>;

export const LinkInboxBody = z.object({ transactionId: Id }).strict();
export type LinkInboxBody = z.infer<typeof LinkInboxBody>;

export const InboxForBody = z.object({ personId: Id.nullable() }).strict();
export type InboxForBody = z.infer<typeof InboxForBody>;

const WritableFrequency = RecurringFrequency.exclude(['unknown']);
export const RecurringItem = z.object({
  id: z.string(), source: z.enum(['plaid', 'manual']), name: z.string(), frequency: RecurringFrequency, amountCents: Cents, variable: z.boolean(),
  lastDate: DateStr, lastCents: Cents, nextDate: DateStr.nullable(), monthlyCents: Cents.nullable(), priceUpCents: Cents, isNew: z.boolean(), hidden: z.boolean(),
  /** Two expected charges missed, or cancelled by hand with no charge since: no next date, out of upcoming and the monthly total. */
  ended: z.boolean(),
  /** Ended because the owner marked it cancelled (always also ended). */
  cancelled: z.boolean(),
  /** Ended because Plaid stopped tracking the stream (always also ended); a new charge alone doesn't bring it back. */
  stopped: z.boolean(),
});
export type RecurringItem = z.infer<typeof RecurringItem>;
export const RecurringList = z.object({ upcoming: z.array(RecurringItem), items: z.array(RecurringItem), monthlyTotalCents: Cents, dueThisWeek: z.number().int() });
export type RecurringList = z.infer<typeof RecurringList>;
export const PatchRecurringBody = z.object({ hidden: z.boolean().optional(), name: z.string().trim().min(1).max(100).nullable().optional(), frequency: WritableFrequency.optional(),
  /** true: cancelled as of max(today, lastDate); only a charge strictly after that date revives it. false: not cancelled. */
  ended: z.boolean().optional() })
  .strict().refine((b) => Object.keys(b).length > 0, { message: 'at least one field is required' });
export type PatchRecurringBody = z.infer<typeof PatchRecurringBody>;
export const CreateRecurringBody = z.object({ transactionId: Id, frequency: WritableFrequency, name: z.string().trim().min(1).max(100).optional() }).strict();
export type CreateRecurringBody = z.infer<typeof CreateRecurringBody>;

export const CHAT_TEXT_MAX = 4000;
export const ChatSummary = z.object({ id: Id, title: z.string(), createdAt: z.string(), updatedAt: z.string() });
export type ChatSummary = z.infer<typeof ChatSummary>;
export const ChatList = z.object({ chats: z.array(ChatSummary) });
export type ChatList = z.infer<typeof ChatList>;
/** One tool Claude used for an answer; input is the tool's arguments, shown when tapped; label is how the app names it. */
export const ChatToolUse = z.object({ name: z.string(), input: z.record(z.string(), z.unknown()), label: z.string().optional() });
export type ChatToolUse = z.infer<typeof ChatToolUse>;
export const ChatMessage = z.object({
  id: Id, role: z.enum(['user', 'assistant']), text: z.string(), tools: z.array(ChatToolUse),
  status: z.enum(['streaming', 'done', 'failed', 'stopped']), errorCode: z.string().nullable(), createdAt: z.string(),
  /** An answer that used financial profile data, read without the profile unlocked: its text and tools are left out until it is. */
  profileLocked: z.boolean().optional(),
});
export type ChatMessage = z.infer<typeof ChatMessage>;
export const ChatDetail = ChatSummary.extend({ messages: z.array(ChatMessage) });
export type ChatDetail = z.infer<typeof ChatDetail>;
/** profileUnlocked: the owner passed Face ID for the financial profile this Ask visit; without it the profile tools refuse, and a chat that
 *  already holds profile data is 403 PROFILE_LOCKED. */
export const SendChatBody = z.object({ clientId: z.string().min(1).max(200), text: z.string().trim().min(1).max(CHAT_TEXT_MAX), profileUnlocked: z.boolean().optional() }).strict();
export type SendChatBody = z.infer<typeof SendChatBody>;
export const AiUsage = z.object({ month: z.string(), costCents: Cents, backupActive: z.boolean() });
export type AiUsage = z.infer<typeof AiUsage>;

const FilingStatus = z.enum(['single', 'married_joint', 'married_separate', 'head_of_household']);
const Money = Cents.min(0).max(MAX_AMOUNT_CENTS);
const StateCode = z.string().regex(/^[A-Z]{2}$/, 'expected a 2-letter state code');
const AboutMe = z.object({
  state: StateCode.nullable(), filingStatus: FilingStatus.nullable(),
  birthYear: z.number().int().min(1900).nullable(), dependents: z.number().int().min(0).max(20).nullable(),
  retirementPct: z.number().min(0).max(100).nullable(), retirementKind: z.enum(['pre_tax', 'roth', 'mixed']).nullable(),
  /** has a health savings account */
  hsa: z.boolean().nullable(), note: z.string().max(2000).nullable(),
});
export const Profile = AboutMe.extend({ updatedAt: z.string().nullable() });
export type Profile = z.infer<typeof Profile>;
/** Left-out fields keep their value; null clears. birthYear is at most the owner's current year. */
export const PutProfileBody = AboutMe.partial().strict();
export type PutProfileBody = z.infer<typeof PutProfileBody>;

const JobFields = z.object({
  employer: z.string().trim().min(1).max(200), title: z.string().trim().max(200).nullable(),
  status: z.enum(['offered', 'accepted', 'declined', 'current', 'past']), startDate: DateInput.nullable(), endDate: DateInput.nullable(),
  /** annual base pay; monthlyCents and hourlyCents are the pay as stated when it's monthly or hourly */
  baseCents: Money.nullable(), monthlyCents: Money.nullable(), hourlyCents: Money.nullable(), hoursPerWeek: z.number().gt(0).max(168).nullable(), bonusTargetPct: z.number().min(0).max(1000).nullable(),
  signingBonusCents: Money.nullable(), relocationCents: Money.nullable(), note: z.string().max(2000).nullable(),
});
const datesInOrder = (j: { startDate?: string | null; endDate?: string | null }) => !j.startDate || !j.endDate || j.startDate <= j.endDate;
export const Job = JobFields.extend({ id: Id, createdAt: z.string(), updatedAt: z.string() });
export type Job = z.infer<typeof Job>;
export const CreateJobBody = JobFields.partial().required({ employer: true, status: true }).strict()
  .refine(datesInOrder, { message: 'must be on or after startDate', path: ['endDate'] });
export type CreateJobBody = z.infer<typeof CreateJobBody>;
export const PatchJobBody = JobFields.partial().strict().refine((b) => Object.keys(b).length > 0, { message: 'at least one field is required' });
export type PatchJobBody = z.infer<typeof PatchJobBody>;

const GrantFields = z.object({
  kind: z.enum(['rsu', 'option']), shares: z.number().positive().max(1e12).nullable(), valueCents: Money.nullable(),
  /** options only: the price per share */
  strikeCents: Money.nullable(), grantDate: DateInput,
  cliffMonths: z.number().int().min(0).max(240), vestMonths: z.number().int().min(1).max(240), vestEveryMonths: z.number().int().min(1).max(240),
});
export const EquityGrant = GrantFields.extend({ id: Id, jobId: Id });
export type EquityGrant = z.infer<typeof EquityGrant>;
/** POST takes every field (shares, valueCents and strikeCents may be left out as null); PATCH takes any of them and checks the result;
 *  a PATCH to rsu without a strikeCents clears the strike. */
export const GrantBody = GrantFields.partial({ shares: true, valueCents: true, strikeCents: true, cliffMonths: true }).strict()
  .refine((g) => g.shares != null || g.valueCents != null, { message: 'shares or valueCents is required', path: ['shares'] })
  .refine((g) => g.kind !== 'option' || g.strikeCents != null, { message: 'an option needs a strike price', path: ['strikeCents'] })
  .refine((g) => g.kind === 'option' || g.strikeCents == null, { message: 'only an option has a strike price', path: ['strikeCents'] })
  .refine((g) => (g.cliffMonths ?? 0) <= g.vestMonths, { message: 'must be at most vestMonths', path: ['cliffMonths'] })
  .refine((g) => g.vestEveryMonths <= g.vestMonths, { message: 'must be at most vestMonths', path: ['vestEveryMonths'] });
export type GrantBody = z.infer<typeof GrantBody>;
/** a cleared cliff (null) is 0, as when a create leaves it out */
export const PatchGrantBody = GrantFields.partial().extend({ cliffMonths: GrantFields.shape.cliffMonths.nullable().transform((v) => v ?? 0).optional() })
  .strict().refine((b) => Object.keys(b).length > 0, { message: 'at least one field is required' });
export type PatchGrantBody = z.infer<typeof PatchGrantBody>;
export const VestEvent = z.object({ date: DateStr, shares: z.number().nullable(), valueCents: Cents.nullable(), grantId: Id });
export type VestEvent = z.infer<typeof VestEvent>;
const PayStubFields = z.object({
  jobId: Id.nullable(), payDate: DateInput, periodStart: DateInput.nullable(), periodEnd: DateInput.nullable(),
  grossCents: Money, federalCents: Money, stateCents: Money, socialSecurityCents: Money, medicareCents: Money, retirementCents: Money,
  otherDeductionsCents: Money,
  /** after-tax additions (reimbursements, stipends) */
  otherPayCents: Money, netCents: Money, ytdGrossCents: Money.nullable(),
});
/** transactionIds: the linked deposits Plaid still has, oldest first (a paycheck split across accounts has several). */
export const PayStub = PayStubFields.extend({ id: Id, transactionIds: z.array(Id), createdAt: z.string() });
export type PayStub = z.infer<typeof PayStub>;
const STUB_PARTS = ['federalCents', 'stateCents', 'socialSecurityCents', 'medicareCents', 'retirementCents', 'otherDeductionsCents', 'otherPayCents'] as const;
/** gross minus every deduction plus other pay */
export const stubNet = (s: Partial<Record<(typeof STUB_PARTS)[number], number | null>> & { grossCents: number }) =>
  STUB_PARTS.reduce((n, k) => (k === 'otherPayCents' ? n + (s[k] ?? 0) : n - (s[k] ?? 0)), s.grossCents);
/** Left-out deduction lines and other pay are 0; gross minus every line plus other pay must equal net within a cent. PATCH checks the merged stub. */
export const PayStubBody = PayStubFields.partial().required({ payDate: true, grossCents: true, netCents: true }).strict()
  .refine((s) => Math.abs(stubNet(s) - s.netCents) <= 1, { message: 'gross minus deductions plus other pay must equal net', path: ['netCents'] })
  .refine((s) => s.ytdGrossCents == null || s.ytdGrossCents >= s.grossCents, { message: 'must be at least grossCents', path: ['ytdGrossCents'] })
  .refine((s) => !s.periodStart || !s.periodEnd || s.periodStart <= s.periodEnd, { message: 'must be on or after periodStart', path: ['periodEnd'] });
export type PayStubBody = z.infer<typeof PayStubBody>;
/** a cleared deduction line (null) is 0, as when a create leaves it out */
export const PatchPayStubBody = PayStubFields.partial()
  .extend(Object.fromEntries(STUB_PARTS.map((k) => [k, Money.nullable().transform((v) => v ?? 0).optional()])) as { [K in typeof STUB_PARTS[number]]: z.ZodOptional<z.ZodPipe<z.ZodNullable<typeof Money>, z.ZodTransform<number, number | null>>> })
  .strict().refine((b) => Object.keys(b).length > 0, { message: 'at least one field is required' });
export type PatchPayStubBody = z.infer<typeof PatchPayStubBody>;
/** The stub's deposits, replacing any linked before; they add up to its net exactly. Empty unlinks. */
export const LinkPayStubBody = z.object({ transactionIds: z.array(Id).max(10) }).strict();
export type LinkPayStubBody = z.infer<typeof LinkPayStubBody>;
/** Deposits on bank accounts within 3 days of the pay date, at most the net and held by no other stub, closest first; suggestions are
 *  single deposits and pairs that add up to the net (ids into deposits). */
export const PayStubMatches = z.object({ deposits: z.array(Transaction), suggestions: z.array(z.array(Id)) });
export type PayStubMatches = z.infer<typeof PayStubMatches>;

const TaxFormFields = z.object({
  jobId: Id.nullable(), year: z.number().int().min(2000), kind: z.enum(['w2', '1099_nec', '1099_int', '1099_div', '1099_b', '1099_misc', 'other']),
  payer: z.string().trim().min(1).max(200),
  /** wages (W-2 box 1), box 1, or the form's total */
  amountCents: Money, federalWithheldCents: Money.nullable(), state: StateCode.nullable(), stateWithheldCents: Money.nullable(),
  ssWagesCents: Money.nullable(), medicareWagesCents: Money.nullable(),
});
export const TaxForm = TaxFormFields.extend({ id: Id, createdAt: z.string() });
export type TaxForm = z.infer<typeof TaxForm>;
/** year runs from 2000 to the owner's next year */
export const TaxFormBody = TaxFormFields.partial().required({ year: true, kind: true, payer: true, amountCents: true }).strict();
export type TaxFormBody = z.infer<typeof TaxFormBody>;
export const PatchTaxFormBody = TaxFormFields.partial().strict().refine((b) => Object.keys(b).length > 0, { message: 'at least one field is required' });
export type PatchTaxFormBody = z.infer<typeof PatchTaxFormBody>;

const TaxReturnFields = z.object({
  year: z.number().int().min(2000), jurisdiction: z.union([z.literal('federal'), StateCode], { error: "expected 'federal' or a 2-letter state code" }),
  filingStatus: FilingStatus.nullable(), wagesCents: Money.nullable(), totalIncomeCents: LedgerCents.nullable(), agiCents: LedgerCents.nullable(),
  deductionKind: z.enum(['standard', 'itemized']).nullable(), deductionCents: Money.nullable(), taxableIncomeCents: Money.nullable(),
  totalTaxCents: Money.nullable(), creditsCents: Money.nullable(), withholdingCents: Money.nullable(),
  /** positive refund, negative owed */
  refundCents: LedgerCents.nullable(), capitalGainsCents: LedgerCents.nullable(), capitalLossCarryoverCents: Money.nullable(),
});
export const TaxReturn = TaxReturnFields.extend({ id: Id, createdAt: z.string(), updatedAt: z.string() });
export type TaxReturn = z.infer<typeof TaxReturn>;
/** Upserts by year + jurisdiction: left-out fields keep their value; null clears. */
export const TaxReturnBody = TaxReturnFields.partial().required({ year: true, jurisdiction: true }).strict();
export type TaxReturnBody = z.infer<typeof TaxReturnBody>;
/** Newest year first; effectiveRate is the federal return's totalTax / totalIncome (4 places), null without one. */
export const TaxYears = z.object({
  years: z.array(z.object({ year: z.number().int(), returns: z.array(TaxReturn), forms: z.array(TaxForm), effectiveRate: z.number().nullable() })),
});
export type TaxYears = z.infer<typeof TaxYears>;

/** A job's W-4: step 1(c) filing status (single covers married filing separately), the step 2(c) box, step 3's total, steps 4(a)–(c)
 *  (the extra withholding is per pay period), and exempt. Only the latest applies, so a job has one. */
const W4Fields = z.object({
  signedOn: DateInput.nullable(), filingStatus: z.enum(['single', 'married_joint', 'head_of_household']).nullable(), multipleJobs: z.boolean().nullable(),
  dependentsCents: Money.nullable(), otherIncomeCents: Money.nullable(), deductionsCents: Money.nullable(), extraWithholdingCents: Money.nullable(),
  exempt: z.boolean().nullable(),
});
export const W4 = W4Fields.extend({ jobId: Id, updatedAt: z.string() });
export type W4 = z.infer<typeof W4>;
/** Replaces the job's W-4: a left-out field is null. */
export const W4Body = W4Fields.partial().strict();
export type W4Body = z.infer<typeof W4Body>;

/** A job's state withholding certificate (California's DE-4 and the like), one per state: allowances rather than the W-4's steps. */
const StateW4Fields = z.object({
  state: StateCode, signedOn: DateInput.nullable(), filingStatus: z.enum(['single', 'married', 'head_of_household']).nullable(),
  // 999 is a common DE-4 entry for no state withholding
  allowances: z.number().int().min(0).max(999).nullable(), additionalAllowances: z.number().int().min(0).max(999).nullable(),
  extraWithholdingCents: Money.nullable(), exempt: z.boolean().nullable(),
});
export const StateW4 = StateW4Fields.extend({ jobId: Id, updatedAt: z.string() });
export type StateW4 = z.infer<typeof StateW4>;
/** Replaces the job's form for that state: a left-out field is null. */
export const StateW4Body = StateW4Fields.omit({ state: true }).partial().strict();
export type StateW4Body = z.infer<typeof StateW4Body>;

export const JobDetail = Job.extend({
  grants: z.array(EquityGrant), nextVests: z.array(VestEvent), stubs: z.array(PayStub), forms: z.array(TaxForm), w4: W4.nullable(),
  /** by state */
  stateW4s: z.array(StateW4),
});
export type JobDetail = z.infer<typeof JobDetail>;

// What Claude read off a document for the owner to review: a missing field or a value that doesn't fit is null.
const draft = <S extends z.ZodRawShape>(o: z.ZodObject<S>) => z.object(Object.fromEntries(Object.entries(o.shape)
  .map(([k, s]) => [k, (s as z.ZodType).nullable().default(null).catch(null)])) as unknown as { [K in keyof S]: z.ZodCatch<z.ZodDefault<z.ZodNullable<S[K]>>> });
export const ProfileDrafts = {
  tax_return: draft(TaxReturnFields),
  tax_form: draft(TaxFormFields.omit({ jobId: true })),
  pay_stub: draft(PayStubFields.omit({ jobId: true }).extend({ employer: JobFields.shape.employer })),
  w4: draft(W4Fields.extend({ employer: JobFields.shape.employer })),
  state_w4: draft(StateW4Fields.extend({ employer: JobFields.shape.employer })),
  offer: draft(JobFields.omit({ status: true })).extend({ grants: z.array(draft(GrantFields).nullable().catch(null)).default([]).catch([])
    .transform((g) => g.filter((x) => x !== null).slice(0, 20)) }),
};
export const ProfileKind = z.enum(['tax_return', 'tax_form', 'pay_stub', 'offer', 'w4', 'state_w4']);
export type ProfileKind = z.infer<typeof ProfileKind>;
/** pages are base64 JPEGs; the whole body is at most 8 MB */
export const ProfileReadBody = z.object({ kind: ProfileKind, pages: z.array(z.string().min(1)).min(1).max(24) }).strict();
export type ProfileReadBody = z.infer<typeof ProfileReadBody>;
/** field names Claude is unsure of */
export const ProfileUncertain = z.array(z.string().max(100)).max(100).default([]).catch([]);
export const ProfileReadResult = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('tax_return'), draft: ProfileDrafts.tax_return, uncertain: ProfileUncertain }),
  z.object({ kind: z.literal('tax_form'), draft: ProfileDrafts.tax_form, uncertain: ProfileUncertain }),
  /** stubs: every pay stub in the pages, in order; draft and uncertain are the first one's (what servers before 2.2.1 sent alone) */
  z.object({ kind: z.literal('pay_stub'), draft: ProfileDrafts.pay_stub, uncertain: ProfileUncertain,
    stubs: z.array(z.object({ draft: ProfileDrafts.pay_stub, uncertain: ProfileUncertain,
      /** a stub with this pay date, gross and net is already saved */
      saved: z.boolean() })).min(1) }),
  z.object({ kind: z.literal('offer'), draft: ProfileDrafts.offer, uncertain: ProfileUncertain }),
  z.object({ kind: z.literal('w4'), draft: ProfileDrafts.w4, uncertain: ProfileUncertain }),
  z.object({ kind: z.literal('state_w4'), draft: ProfileDrafts.state_w4, uncertain: ProfileUncertain }),
]);
export type ProfileReadResult = z.infer<typeof ProfileReadResult>;
