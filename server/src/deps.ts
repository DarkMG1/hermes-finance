import type { Db } from './db.ts';
import type { Config } from './config.ts';
import type { PlaidPort } from './plaid/port.ts';
import type { PricePort } from './prices/port.ts';
import type { ReceiptReader } from './receipt-reader.ts';

export type Deps = { db: Db; config: Config; plaid: PlaidPort; prices: PricePort | null; receiptReader: ReceiptReader | null; now: () => Date };
