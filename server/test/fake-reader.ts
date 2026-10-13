import type { ReadResult, ReceiptReader } from '../src/receipt-reader.ts';

export class FakeReader implements ReceiptReader {
  next: ReadResult | Error = { items: [{ name: 'Synthetic Bread', amountCents: 400 }, { name: 'Synthetic Jam', amountCents: 600 }], taxCents: 50, tipCents: 0, feesCents: 0, totalCents: 1050, merchant: 'Synthetic Grocer', purchaseDate: '2026-03-14', model: 'fake-model' };
  calls = 0;
  /** Runs during the read, e.g. to delete the receipt mid-flight. */
  onRead?: () => void;

  async read(): Promise<ReadResult> {
    this.calls += 1;
    this.onRead?.();
    if (this.next instanceof Error) throw this.next;
    return this.next;
  }
}
