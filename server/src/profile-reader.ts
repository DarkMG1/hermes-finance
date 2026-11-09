import { z } from 'zod';
import { ProfileDrafts, ProfileUncertain, type ProfileKind, type ProfileReadResult } from '@hermes/shared';
import type { Deps } from './deps.ts';
import { ApiError } from './errors.ts';
import { ReaderError } from './receipt-reader.ts';
import { ClaudeError, type Claude } from './chat/anthropic.ts';
import { jsonSchema } from './chat/tools.ts';

export type ProfileReadOutput = ProfileReadResult & { model: string };
export interface ProfileReader { read(kind: ProfileKind, pages: Buffer[]): Promise<ProfileReadOutput> }

// The app's Redaction rules, so what the photo boxes the text blanks: the app redacts the photo first, this catches what Claude still read.
// SSN/ITIN or EIN shaped, bounded by digits only (a label glued on, "SSN000-00-0000", still counts); separators: hyphen, en or em dash,
// dot, or a run of spaces; an SSN has both or neither, so a ZIP+4 (00000-0000) is kept; nine digits each split by spaces (a form's
// one-digit-per-cell box); a `$` before or `.digit` after makes it an amount.
const SEP = '(?:[-\u2013\u2014.]| +)';
const IDENTIFIER = new RegExp(`(?<![\\d$])(?:\\d{3}(?:${SEP}\\d{2}${SEP}|\\d{2})\\d{4}|\\d{2}${SEP}\\d{7}|\\d(?: +\\d){8})(?!\\d|\\.\\d)`);
// with an identifier's label: any run of 5+ digits, spaces and dashes (not a date), like the app's digits under such a label
const ID_KEYWORD = /\b(?:social security|ssn|itin|taxpayer identification|identifying number|employer identification|ein)\b/i;
const DIGIT_RUN = /(?<![\d$]|\d[.,])\d[\d \-\u2013\u2014]*\d(?!\d|[.,]\d)/g;
// account and routing numbers: with one of these words, 8 to 17 digits in a run or in groups split by spaces or hyphens (not a date)
const KEYWORD = /\b(?:accounts?|acct|routing|aba|rtn)\b/i;
const RUN = /(?<![\d$]|\d[.,])\d{8,17}(?!\d|[.,]\d)/;
const GROUPS = /(?<![\d$]|\d[.,])\d{3,}(?:[ -]\d{2,}){1,4}(?!\d|[.,]\d)/g;
const DATE = /^\d{4}[- ]\d{1,2}[- ]\d{1,2}$/;
const grouped = (m: string) => { const n = m.replace(/\D/g, '').length; return n >= 8 && n <= 17 && !DATE.test(m); };
const labelled = (m: string) => m.replace(/\D/g, '').length >= 5 && !DATE.test(m);
const sensitive = (s: string) => IDENTIFIER.test(s) || (ID_KEYWORD.test(s) && [...s.matchAll(DIGIT_RUN)].some((m) => labelled(m[0]))) || (KEYWORD.test(s) && (RUN.test(s) || [...s.matchAll(GROUPS)].some((m) => grouped(m[0]))));
export const scrubIdentifiers = <T>(v: T): T => (typeof v === 'string' ? (sensitive(v) ? null : v)
  : Array.isArray(v) ? v.map(scrubIdentifiers)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrubIdentifiers(x)])) : v) as T;

const active = new WeakSet<Deps['db']>();

/** One read at a time per server; nothing is stored. */
export async function readProfile(deps: Deps, kind: ProfileKind, pages: Buffer[]): Promise<ProfileReadResult> {
  if (!deps.profileReader) throw new ApiError(503, 'READER_NOT_CONFIGURED', 'document reading is not set up');
  if (active.has(deps.db)) throw new ApiError(409, 'READ_IN_PROGRESS', 'another document is being read');
  active.add(deps.db);
  try {
    const r = await deps.profileReader.read(kind, pages);
    const clean = (x: { draft: object; uncertain: string[] }) => ({ draft: scrubIdentifiers(x.draft), uncertain: x.uncertain.filter((k) => Object.hasOwn(x.draft, k)) });
    if (r.kind !== 'pay_stub') return { kind: r.kind, ...clean(r) } as ProfileReadResult;
    const stubs = r.stubs.map(clean);
    return { kind: r.kind, ...stubs[0]!, stubs } as ProfileReadResult;
  } catch (e) {
    const code = e instanceof ReaderError ? e.code : 'UNKNOWN';
    if (code === 'AI_CREDITS_EXHAUSTED') throw new ApiError(402, 'AI_CREDITS_EXHAUSTED', 'the Anthropic API keys are out of credit');
    if (code === 'INVALID_OUTPUT') throw new ApiError(422, 'UNREADABLE', "couldn't read this document");
    console.error(`[hermes] profile read failed code=${code}`);
    throw new ApiError(502, 'READ_FAILED', "couldn't read this document");
  } finally {
    active.delete(deps.db);
  }
}

const KINDS: Record<ProfileKind, [label: string, hints: string]> = {
  tax_return: ['tax return', "jurisdiction: 'federal' for a federal return, else the 2-letter state code. refundCents: positive for a refund, negative when tax is owed."],
  tax_form: ['W-2 or 1099 form', 'kind: w2 for a W-2, else the 1099 type. payer: the employer or payer name. amountCents: W-2 box 1 wages, else box 1 or the total.'],
  pay_stub: ['pay stub', 'The pages may hold several pay stubs: put each in stubs, in page order, once each (a stub over two pages is one entry). '
    + 'Amounts are for that stub\'s pay period; ytdGrossCents is the year-to-date gross. otherDeductionsCents: the sum of every deduction and tax '
    + 'without its own field (local tax, disability, insurance, HSA and the rest). otherPayCents: after-tax additions such as reimbursements. '
    + 'Gross minus all deductions plus otherPayCents must equal netCents. employer: the employer name.'],
  w4: ['W-4 form', "signedOn: the date signed. filingStatus: step 1(c), 'single' for single or married filing separately. multipleJobs: true when step 2(c) is checked. "
    + 'dependentsCents: the step 3 total. otherIncomeCents, deductionsCents, extraWithholdingCents: steps 4(a), 4(b) and 4(c). exempt: true when Exempt is written below step 4(c). '
    + 'employer: the employer name in the employers only section, if filled in.'],
  offer: ['offer letter', 'baseCents: the annual base salary as stated, null for hourly pay or any letter without a yearly figure (never work one out). hourlyCents: the hourly rate as stated. hoursPerWeek: the weekly hours as stated (20 for 40 hours every 2 weeks). bonusTargetPct: a percent (15 for 15%). grants: each equity grant; vestMonths is the whole vesting length, vestEveryMonths the interval after the cliff.'],
};

type MessagesReply = { content?: { type: string; name?: string; input?: unknown }[] };

export function createAnthropicProfileReader(claude: Claude, model: string): ProfileReader {
  return {
    async read(kind, pages) {
      const name = `record_${kind}`;
      const [label, hints] = KINDS[kind];
      const one = (ProfileDrafts[kind] as z.ZodObject).extend({ uncertain: ProfileUncertain });
      // a PDF exported from payroll often holds a whole run of pay stubs; a malformed one is dropped, not the rest
      const schema = kind === 'pay_stub' ? z.object({ stubs: z.array(one.nullable().catch(null)).transform((s) => s.filter((x) => x !== null).slice(0, 30)) }) : one;
      let reply: MessagesReply;
      try {
        reply = (await claude.messages('profile', {
          // Sonnet 5.5 refuses a forced tool_choice ("tool"/"any"), so the instructions ask for the call
          model, max_tokens: kind === 'pay_stub' ? 16384 : 8192,
          tools: [{ name, description: kind === 'pay_stub' ? 'Record every pay stub in the pages, one entry per pay date.' : `Record the fields read from the ${label}.`,
            input_schema: jsonSchema(schema) }],
          messages: [{ role: 'user', content: [
            ...pages.map((p) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: p.toString('base64') } })),
            { type: 'text', text: `Read this ${label}. Amounts in integer cents. Dates YYYY-MM-DD. Leave a field null when absent. ${hints}
Never return SSNs, ITINs, EINs or account numbers. List field names you are unsure of in uncertain. Call ${name} once.` },
          ] }],
        })).reply as MessagesReply;
      } catch (e) {
        // a reply that isn't JSON is a transport fault, not an unreadable document
        throw e instanceof ClaudeError ? new ReaderError(e.code === 'INVALID_OUTPUT' ? 'BAD_REPLY' : e.code) : e;
      }
      const content = reply.content;
      const call = Array.isArray(content) ? content.find((c) => c.type === 'tool_use' && c.name === name) : undefined;
      const parsed = schema.safeParse(call?.input);
      if (!parsed.success) throw new ReaderError('INVALID_OUTPUT');
      if (kind === 'pay_stub') {
        const stubs = (parsed.data as { stubs: ({ uncertain: string[] } & Record<string, unknown>)[] }).stubs.map(({ uncertain, ...draft }) => ({ draft, uncertain }));
        if (!stubs.length) throw new ReaderError('INVALID_OUTPUT');
        return { kind, ...stubs[0]!, stubs, model } as ProfileReadOutput;
      }
      const { uncertain, ...draft } = parsed.data as { uncertain: string[] } & Record<string, unknown>;
      // a letter that doesn't state one of these comes back as 0 despite the instruction; 0 would read as an offer of nothing
      if (kind === 'offer') for (const k of ['baseCents', 'hourlyCents', 'bonusTargetPct', 'signingBonusCents', 'relocationCents']) if ((draft as Record<string, unknown>)[k] === 0) (draft as Record<string, unknown>)[k] = null;
      return { kind, draft, uncertain, model } as ProfileReadOutput;
    },
  };
}
