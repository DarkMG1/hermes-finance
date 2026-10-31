const LABELS: Record<string, string> = {
  spending: 'Spending', expenses: 'Expenses', transactions: 'Transactions', transaction: 'Transaction', payee_history: 'Payee history', bills: 'Bills',
  reimbursements: 'Reimbursements', people: 'People', net_worth: 'Net worth', investments: 'Investments', accounts: 'Accounts', categories: 'Categories',
  search_chats: 'Past chats', read_chat: 'Past chat',
};

export function toolLabel(name: string, input: Record<string, unknown>): string {
  if (name === 'search_chats' && typeof input.query === 'string') return `${LABELS[name]} · ${input.query}`;
  const { from, to } = input;
  const span = from && to ? `${String(from)} – ${String(to)}` : from ? `Since ${String(from)}` : to ? `Through ${String(to)}` : undefined;
  const detail = [span, input.date ?? input.month, input.name, input.range].find((v) => typeof v === 'string');
  const shown = detail && /^\d{4}-\d{2}$/.test(detail)
    ? new Date(`${detail}-01T00:00:00Z`).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }) : detail;
  return `${LABELS[name] ?? name}${shown ? ` · ${shown}` : ''}`;
}
