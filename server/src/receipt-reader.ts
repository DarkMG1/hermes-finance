import type { ReceiptReadOutput } from '@hermes/shared';

export type ReadResult = ReceiptReadOutput & { model: string };
export interface ReceiptReader { read(jpeg: Buffer): Promise<ReadResult> }
export class ReaderError extends Error {
  code: string;
  constructor(code: string) { super(code); this.name = 'ReaderError'; this.code = code; }
}
