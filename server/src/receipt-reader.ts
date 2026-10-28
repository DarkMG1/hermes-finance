import type { ReceiptReadOutput } from '@hermes/shared';
import type { Deps } from './deps.ts';
import { ApiError } from './errors.ts';

export type ReadResult = ReceiptReadOutput & { model: string };
export interface ReceiptReader { read(jpeg: Buffer): Promise<ReadResult> }
export class ReaderError extends Error {
  code: string;
  constructor(code: string) { super(code); this.name = 'ReaderError'; this.code = code; }
}

const reads = new WeakMap<Deps['db'], { active: Set<string>; cooldown: Map<string, number> }>();

export async function readReceipt(deps: Deps, key: string, jpeg: Buffer, automatic = false): Promise<ReadResult> {
  if (!deps.receiptReader) throw new ApiError(503, 'READER_NOT_CONFIGURED', 'receipt reading is not set up');
  let state = reads.get(deps.db);
  if (!state) { state = { active: new Set(), cooldown: new Map() }; reads.set(deps.db, state); }
  const now = deps.now().getTime();
  for (const [id, until] of state.cooldown) if (until <= now) state.cooldown.delete(id);
  if (state.active.has(key)) throw new ApiError(409, 'READ_IN_PROGRESS', 'this receipt is already being read');
  if (state.cooldown.has(key)) throw new ApiError(429, 'READ_COOLDOWN', 'wait 30 seconds before reading this receipt again');
  state.active.add(key);
  try {
    return await deps.receiptReader.read(jpeg);
  } finally {
    state.active.delete(key);
    if (!automatic) state.cooldown.set(key, deps.now().getTime() + 30_000);
  }
}
