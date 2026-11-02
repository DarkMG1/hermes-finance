import type { z } from 'zod';
import { ProfileDrafts, ProfileUncertain, type ProfileKind, type ProfileReadResult } from '@hermes/shared';
import type { Deps } from './deps.ts';
import { ApiError } from './errors.ts';
import { ReaderError } from './receipt-reader.ts';
import { ClaudeError, type Claude } from './chat/anthropic.ts';
import { jsonSchema } from './chat/tools.ts';

export type ProfileReadOutput = ProfileReadResult & { model: string };
export interface ProfileReader { read(kind: ProfileKind, pages: Buffer[]): Promise<ProfileReadOutput> }

// SSN/ITIN or EIN shaped; the app redacts the photo first, this catches what Claude still read
// separators: hyphen, en or em dash, dot, or a run of spaces; an SSN has both or neither, so a ZIP+4 (00000-0000) is kept
const IDENTIFIER = /\b\d{3}(?:(?:[-\u2013\u2014.]| +)\d{2}(?:[-\u2013\u2014.]| +)|\d{2})\d{4}\b|\b\d{2}(?:[-\u2013\u2014.]| +)\d{7}\b/;
export const scrubIdentifiers = <T>(v: T): T => (typeof v === 'string' ? (IDENTIFIER.test(v) ? null : v)
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
    return { kind: r.kind, draft: scrubIdentifiers(r.draft), uncertain: r.uncertain.filter((k) => k in r.draft) } as ProfileReadResult;
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
  pay_stub: ['pay stub', 'Amounts are for this pay period; ytdGrossCents is the year-to-date gross. employer: the employer name.'],
  offer: ['offer letter', 'baseCents: the annual base salary. bonusTargetPct: a percent (15 for 15%). grants: each equity grant; vestMonths is the whole vesting length, vestEveryMonths the interval after the cliff.'],
};

type MessagesReply = { content?: { type: string; name?: string; input?: unknown }[] };

export function createAnthropicProfileReader(claude: Claude, model: string): ProfileReader {
  return {
    async read(kind, pages) {
      const name = `record_${kind}`;
      const [label, hints] = KINDS[kind];
      const schema = (ProfileDrafts[kind] as z.ZodObject).extend({ uncertain: ProfileUncertain });
      let reply: MessagesReply;
      try {
        reply = (await claude.messages('profile', {
          // Sonnet 5.5 refuses a forced tool_choice ("tool"/"any"), so the instructions ask for the call
          model, max_tokens: 8192,
          tools: [{ name, description: `Record the fields read from the ${label}.`, input_schema: jsonSchema(schema) }],
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
      const { uncertain, ...draft } = parsed.data;
      return { kind, draft, uncertain, model } as ProfileReadOutput;
    },
  };
}
