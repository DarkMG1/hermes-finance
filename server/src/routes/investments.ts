import type { FastifyInstance } from 'fastify';
import { HoldingHistoryQuery, InvestmentsHistoryQuery, InvestmentsQuery } from '@hermes/shared';
import type { Deps } from '../deps.ts';
import { ApiError } from '../errors.ts';
import { getHoldingHistory, getInvestments } from '../investments.ts';
import { getNetWorth, localDay } from '../networth.ts';
import { parseBody } from '../validate.ts';

const parseAccountIds = (s: string | undefined): string[] | undefined =>
  s === undefined ? undefined : s.split(',').map((x) => x.trim()).filter(Boolean);

export function investmentRoutes(app: FastifyInstance, deps: Deps): void {
  const { db } = deps;
  app.get('/v1/investments', async (req) => getInvestments(db, parseAccountIds(parseBody(InvestmentsQuery, req.query).accountIds)));
  app.get('/v1/investments/history', async (req) => {
    const q = parseBody(InvestmentsHistoryQuery, req.query);
    return getNetWorth(db, q.range, localDay(deps.now()), { type: 'investment', accountIds: parseAccountIds(q.accountIds) });
  });
  // the key travels in the query: it can hold any character, '/' included
  app.get('/v1/investments/holding-history', async (req) => {
    const q = parseBody(HoldingHistoryQuery, req.query);
    const history = getHoldingHistory(db, q.key, q.range, localDay(deps.now()), parseAccountIds(q.accountIds));
    if (!history) throw new ApiError(404, 'NOT_FOUND', 'holding not found');
    return history;
  });
}
