import { ReceiptReadOutput } from '@hermes/shared';
import { ReaderError, type ReadResult, type ReceiptReader } from '../receipt-reader.ts';

const INSTRUCTIONS = `Read this receipt and call record_receipt once.
- items: every purchased line in printed order. name: the item as printed, tidied (no SKU or barcode numbers). amountCents: the line total in integer cents after quantity (2 x $3.50 is 700). A discount, coupon or instant saving for one item (printed under it, often starting with / or \\, or naming it) is subtracted from that item's amountCents, not listed. Only a saving on the whole order is its own item with a negative amountCents.
- taxCents, tipCents, feesCents (service charge, bag fee, delivery, card surcharge): integer cents, 0 when absent. Never list these as items.
- totalCents: the printed total in integer cents, or null when none is printed.
- merchant: the store or restaurant name as printed at the top, or null.
- purchaseDate: the purchase date as YYYY-MM-DD, or null when none is printed.`;

const TOOL = {
  name: 'record_receipt',
  description: 'Record the line items and totals read from the receipt.',
  input_schema: {
    type: 'object',
    properties: {
      items: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, amountCents: { type: 'integer' } }, required: ['name', 'amountCents'] } },
      taxCents: { type: 'integer' }, tipCents: { type: 'integer' }, feesCents: { type: 'integer' }, totalCents: { type: ['integer', 'null'] },
      merchant: { type: ['string', 'null'] }, purchaseDate: { type: ['string', 'null'] },
    },
    required: ['items', 'taxCents', 'tipCents', 'feesCents', 'totalCents'],
  },
};

type MessagesReply = { content?: { type: string; name?: string; input?: unknown }[]; usage?: { input_tokens?: number; output_tokens?: number } };

export function createAnthropicReader(apiKey: string, model: string, fetchFn: typeof fetch = fetch): ReceiptReader {
  return {
    async read(jpeg: Buffer): Promise<ReadResult> {
      let res: Response;
      try {
        res = await fetchFn('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
          body: JSON.stringify({
            // Sonnet 5.5 refuses a forced tool_choice ("tool"/"any"), so the instructions ask for the call
            model, max_tokens: 8192, tools: [TOOL],
            messages: [{ role: 'user', content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpeg.toString('base64') } },
              { type: 'text', text: INSTRUCTIONS },
            ] }],
          }),
          signal: AbortSignal.timeout(60_000),
        });
      } catch (e) {
        throw new ReaderError(e instanceof Error && e.name === 'TimeoutError' ? 'TIMEOUT' : 'UNREACHABLE');
      }
      if (!res.ok) throw new ReaderError(`HTTP_${res.status}`);
      const reply = await res.json().catch(() => null) as MessagesReply | null;
      const content = reply?.content;
      const call = Array.isArray(content) ? content.find((c) => c.type === 'tool_use' && c.name === 'record_receipt') : undefined;
      const parsed = ReceiptReadOutput.safeParse(call?.input);
      if (!parsed.success) throw new ReaderError('INVALID_OUTPUT');
      // counts only: never the key, the image or the item text
      console.log(`[hermes] receipt read model=${model} in=${reply?.usage?.input_tokens ?? '?'} out=${reply?.usage?.output_tokens ?? '?'} items=${parsed.data.items.length}`);
      return { ...parsed.data, model };
    },
  };
}
