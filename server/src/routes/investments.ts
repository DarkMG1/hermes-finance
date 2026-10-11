import type { FastifyInstance } from 'fastify';
import { HoldingHistoryQuery, NetWorthQuery } from '@hermes/shared';
import type { Deps } from '../deps.ts';
import { ApiError } from '../errors.ts';
import { getHoldingHistory, getInvestments } from '../investments.ts';
import { getNetWorth, localDay } from '../networth.ts';
import { parseBody } from '../validate.ts';

export function investmentRoutes(app: FastifyInstance, deps: Deps): void {
  const { db } = deps;
  app.get('/v1/investments', async () => getInvestments(db));
  app.get('/v1/investments/history', async (req) => getNetWorth(db, parseBody(NetWorthQuery, req.query).range, localDay(deps.now()), 'investment'));
  // the key travels in the query: it can hold any character, '/' included
  app.get('/v1/investments/holding-history', async (req) => {
    const { key, range } = parseBody(HoldingHistoryQuery, req.query);
    const history = getHoldingHistory(db, key, range, localDay(deps.now()));
    if (!history) throw new ApiError(404, 'NOT_FOUND', 'holding not found');
    return history;
  });
}
