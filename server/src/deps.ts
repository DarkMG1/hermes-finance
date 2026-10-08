import type { Db } from './db.ts';
import type { Config } from './config.ts';
import type { PlaidPort } from './plaid/port.ts';

export type Deps = { db: Db; config: Config; plaid: PlaidPort; now: () => Date };
