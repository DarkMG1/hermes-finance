import { ProfileDrafts, type ProfileKind } from '@hermes/shared';
import type { ProfileReader, ProfileReadOutput } from '../src/profile-reader.ts';
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

export class FakeProfileReader implements ProfileReader {
  next: ProfileReadOutput | Error = stubRead([{ employer: 'SYNTHETIC EMPLOYER', payDate: '2026-03-13', grossCents: 420000, federalCents: 50000, netCents: 300000 }], ['stateCents']);
  calls: { kind: ProfileKind; pages: Buffer[] }[] = [];
  /** The read waits for this, e.g. to hold the busy guard. */
  hold?: Promise<unknown>;

  async read(kind: ProfileKind, pages: Buffer[]): Promise<ProfileReadOutput> {
    this.calls.push({ kind, pages });
    await this.hold;
    if (this.next instanceof Error) throw this.next;
    return this.next;
  }
}

/** A pay stub read of these stubs, each unsure of `uncertain`. */
export const stubRead = (stubs: Record<string, unknown>[], uncertain: string[] = []): Extract<ProfileReadOutput, { kind: 'pay_stub' }> => {
  const all = stubs.map((s) => ({ draft: ProfileDrafts.pay_stub.parse(s), uncertain }));
  return { kind: 'pay_stub', ...all[0]!, stubs: all, model: 'fake-model' };
};
