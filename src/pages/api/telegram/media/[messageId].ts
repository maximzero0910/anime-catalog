import { clearTelegramMediaFailure, getPlayableTelegramMessage, recordTelegramMediaFailure } from '../../../../lib/telegram/storage';
import { telegramVideoRange } from '../../../../lib/telegram/client';
import { parseTelegramByteRange } from '../../../../lib/telegram/range';

export const prerender = false;
const CHUNK_BYTES = 512 * 1024;

async function serve(messageId: number, request: Request, head = false): Promise<Response> {
  const cached = getPlayableTelegramMessage(messageId);
  if (!cached) return Response.json({ error: 'telegram-media-not-indexed' }, { status: 404 });
  const size = cached.file_size;
  if (!Number.isSafeInteger(size) || size <= 0) return Response.json({ error: 'telegram-media-size-unknown' }, { status: 502 });
  const range = parseTelegramByteRange(request.headers.get('range'), size);
  const baseHeaders = new Headers({ 'Accept-Ranges': 'bytes', 'Content-Type': cached.mime_type || 'video/mp4', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
  if (range === 'invalid') { baseHeaders.set('Content-Range', `bytes */${size}`); return new Response(null, { status: 416, headers: baseHeaders }); }
  const start = range?.start ?? 0; const end = range?.end ?? size - 1;
  const length = end - start + 1;
  baseHeaders.set('Content-Length', String(length));
  if (range) baseHeaders.set('Content-Range', `bytes ${start}-${end}/${size}`);
  if (head) return new Response(null, { status: range ? 206 : 200, headers: baseHeaders });

  let iterator = await telegramVideoRange(messageId, start, end);
  let first: IteratorResult<Uint8Array>;
  try { first = await iterator[Symbol.asyncIterator]().next(); if (first.done) throw new Error('Telegram returned no media data'); }
  catch {
    iterator = await telegramVideoRange(messageId, start, end, true);
    first = await iterator[Symbol.asyncIterator]().next();
    if (first.done) throw new Error('Telegram returned no media data after refreshing the file reference');
  }
  clearTelegramMediaFailure(messageId);
  const readerIterator = iterator[Symbol.asyncIterator]();
  let initial: IteratorResult<Uint8Array> | undefined = first;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = initial ?? await readerIterator.next(); initial = undefined;
        if (next.done) controller.close(); else controller.enqueue(next.value);
      } catch (error) {
        if (cancelled || request.signal.aborted || controller.desiredSize === null) return;
        recordTelegramMediaFailure(messageId, error instanceof Error ? error.message : String(error));
        controller.error(error);
      }
    },
    async cancel() {
      cancelled = true;
      try { await readerIterator.return?.(); } catch { /* A viewer closing a range request is not a failed Telegram reference. */ }
    },
  }, { highWaterMark: 1, size: chunk => chunk.byteLength / CHUNK_BYTES });
  return new Response(body, { status: range ? 206 : 200, headers: baseHeaders });
}

export async function GET({ params, request }: { params: { messageId?: string }; request: Request }): Promise<Response> {
  const messageId = Number(params.messageId);
  if (!Number.isSafeInteger(messageId) || messageId < 1) return Response.json({ error: 'invalid-message-id' }, { status: 400 });
  try { return await serve(messageId, request); }
  catch (error) { const reason = error instanceof Error ? error.message : String(error); recordTelegramMediaFailure(messageId, reason); console.error({ provider: 'telegram', ep: messageId, reason }); return Response.json({ error: 'telegram-media-unavailable' }, { status: 502 }); }
}
export async function HEAD({ params, request }: { params: { messageId?: string }; request: Request }): Promise<Response> {
  const messageId = Number(params.messageId);
  if (!Number.isSafeInteger(messageId) || messageId < 1) return new Response(null, { status: 400 });
  try { return await serve(messageId, request, true); }
  catch { return new Response(null, { status: 502 }); }
}

