/** One return-style line; `source` says where the number came from, `assumption` what was assumed to get it. */
export type Line = { key: string; label: string; cents: number; source: string; assumption?: string };
export type ReturnResult = {
  jurisdiction: 'federal' | string; supported: boolean; lines: Line[]; taxCents: number; withheldCents: number;
  /** + refund, − owed */
  balanceCents: number;
};
