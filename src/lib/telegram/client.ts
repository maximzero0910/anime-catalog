import './config';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { Api } from 'telegram/tl';
import bigInt from 'big-integer';
import type { EntityLike } from 'telegram/define';
import { getTelegramMessage, saveTelegramMessage, telegramSyncCheckpoint, updateTelegramSyncState, type TelegramMessageRow } from './storage';
import { matchTelegramMessage } from './matching';

const numberEnv = Number(process.env.TG_API_ID ?? process.env.TELEGRAM_API_ID);
const apiHash = process.env.TG_API_HASH ?? process.env.TELEGRAM_API_HASH ?? '';
const sessionString = process.env.TG_SESSION ?? process.env.TELEGRAM_SESSION ?? '';
export const telegramChannel = process.env.TG_CHANNEL ?? process.env.TELEGRAM_CHANNEL ?? '';
let clientPromise: Promise<TelegramClient> | undefined;
const mediaMessageCache = new Map<number, { expiresAt: number; value: Awaited<ReturnType<typeof fetchTelegramVideo>> }>();

export function telegramConfigured(): boolean { return Number.isSafeInteger(numberEnv) && numberEnv > 0 && apiHash.length >= 32 && sessionString.length >= 50 && !/(your_|placeholder|replace_me)/i.test(sessionString) && Boolean(telegramChannel); }
export async function getTelegramClient(): Promise<TelegramClient> {
  if (!telegramConfigured()) throw new Error('Telegram is not configured; set TG_API_ID, TG_API_HASH, TG_SESSION, and TG_CHANNEL');
  if (!clientPromise) clientPromise = (async () => {
    const client = new TelegramClient(new StringSession(sessionString), numberEnv, apiHash, { connectionRetries: 3, autoReconnect: true, requestRetries: 2, floodSleepThreshold: 60 });
    await client.connect();
    if (!await client.checkAuthorization()) { await client.disconnect(); throw new Error('Telegram session is not authorized; create a GramJS StringSession before starting the service'); }
    return client;
  })().catch(error => { clientPromise = undefined; throw error; });
  return clientPromise;
}
export async function disconnectTelegramClient(): Promise<void> {
  const pending = clientPromise;
  clientPromise = undefined;
  mediaMessageCache.clear();
  if (!pending) return;
  try { await (await pending).disconnect(); } catch { /* A failed connection has no live sender to close. */ }
}
export async function getTelegramChannel(client?: TelegramClient): Promise<EntityLike> {
  return await (client ?? await getTelegramClient()).getEntity(telegramChannel);
}
function isVideoMessage(message: Api.Message): message is Api.Message & { media: Api.MessageMediaDocument & { document: Api.Document } } {
  const media = message.media;
  if (!(media instanceof Api.MessageMediaDocument) || !(media.document instanceof Api.Document)) return false;
  return media.document.mimeType.startsWith('video/') || media.document.attributes.some(attribute => attribute instanceof Api.DocumentAttributeVideo);
}
export function messageToIndexRow(channelId: string, message: Api.Message): TelegramMessageRow {
  if (!isVideoMessage(message)) throw new Error(`Telegram message ${message.id} is not a video document`);
  const doc = message.media.document;
  const fileAttribute = doc.attributes.find(attribute => attribute instanceof Api.DocumentAttributeFilename) as Api.DocumentAttributeFilename | undefined;
  const videoAttribute = doc.attributes.find(attribute => attribute instanceof Api.DocumentAttributeVideo) as Api.DocumentAttributeVideo | undefined;
  return {
    channel_id: channelId, message_id: message.id, caption: message.message ?? '', filename: fileAttribute?.fileName ?? '', mime_type: doc.mimeType || 'video/mp4',
    duration_seconds: videoAttribute?.duration ?? null, file_size: Number(doc.size), document_id: String(doc.id), access_hash: String(doc.accessHash),
    file_reference: Buffer.from(doc.fileReference).toString('base64'), dc_id: doc.dcId, media_json: JSON.stringify({ video: true, groupedId: message.groupedId?.toString() ?? null }),
  };
}
async function fetchTelegramVideo(messageId: number): Promise<{ client: TelegramClient; channel: EntityLike; message: Api.Message & { media: Api.MessageMediaDocument & { document: Api.Document } }; row: TelegramMessageRow }> {
  const client = await getTelegramClient();
  const channel = await getTelegramChannel(client);
  const messages = await client.getMessages(channel, { ids: [messageId] });
  const message = messages[0];
  if (!message || !(message instanceof Api.Message) || !isVideoMessage(message)) throw new Error(`Telegram video message ${messageId} no longer exists or is unavailable`);
  const channelId = String((channel as { id?: unknown }).id ?? telegramChannel);
  return { client, channel, message, row: messageToIndexRow(channelId, message) };
}
export async function freshTelegramVideo(messageId: number, forceRefresh = false): Promise<Awaited<ReturnType<typeof fetchTelegramVideo>>> {
  const cached = mediaMessageCache.get(messageId);
  if (!forceRefresh && cached && cached.expiresAt > Date.now()) return cached.value;
  if (forceRefresh) mediaMessageCache.delete(messageId);
  const value = await fetchTelegramVideo(messageId);
  if (mediaMessageCache.size >= 500) {
    const now = Date.now();
    for (const [id, entry] of mediaMessageCache) if (entry.expiresAt <= now) mediaMessageCache.delete(id);
    while (mediaMessageCache.size >= 500) mediaMessageCache.delete(mediaMessageCache.keys().next().value!);
  }
  mediaMessageCache.set(messageId, { value, expiresAt: Date.now() + 30_000 });
  return value;
}

export async function synchronizeTelegramChannel(): Promise<{ scanned: number; newVideos: number; matched: number; ambiguous: number; unmatched: number }> {
  const client = await getTelegramClient();
  const channel = await getTelegramChannel(client);
  const entity = channel as { id?: unknown; title?: string };
  const channelId = String(entity.id ?? telegramChannel);
  updateTelegramSyncState({ channel: telegramChannel, channelId, channelName: entity.title ?? telegramChannel, status: 'syncing', lastError: null });
  const initial = telegramSyncCheckpoint();
  let checkpoint = initial;
  const totals = { scanned: 0, newVideos: 0, matched: 0, ambiguous: 0, unmatched: 0 };
  try {
    for await (const message of client.iterMessages(channel, { minId: initial, reverse: true })) {
      if (!(message instanceof Api.Message)) continue;
      totals.scanned++;
      if (isVideoMessage(message)) {
        const row = messageToIndexRow(channelId, message);
        const existed = Boolean(getTelegramMessage(message.id, channelId));
        saveTelegramMessage(row);
        if (!existed) totals.newVideos++;
        const result = matchTelegramMessage(row);
        if (result.status === 'MATCHED') totals.matched++;
        else if (result.status === 'AMBIGUOUS') totals.ambiguous++;
        else totals.unmatched++;
      }
      checkpoint = Math.max(checkpoint, message.id);
      updateTelegramSyncState({ checkpoint, progress: totals.scanned });
    }
    updateTelegramSyncState({ status: 'idle', progress: 0, lastSuccess: new Date().toISOString(), lastError: null });
    return totals;
  } catch (error) {
    updateTelegramSyncState({ status: 'failed', lastError: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

export async function telegramVideoRange(messageId: number, start: number, end: number, forceRefresh = false): Promise<AsyncIterable<Uint8Array>> {
  const { client, channel, message } = await freshTelegramVideo(messageId, forceRefresh);
  const document = message.media.document;
  const chunkSize = 512 * 1024;
  const alignedStart = Math.floor(start / chunkSize) * chunkSize;
  const skip = start - alignedStart;
  const requested = end - alignedStart + 1;
  const limit = Math.ceil(requested / chunkSize);
  const iterator = client.iterDownload({ file: message.media, offset: bigInt(alignedStart), limit, chunkSize, requestSize: chunkSize, fileSize: bigInt(Number(document.size)), dcId: document.dcId, msgData: [channel, messageId] });
  async function* trim(): AsyncGenerator<Uint8Array> {
    let remainingSkip = skip;
    let remaining = end - start + 1;
    try {
      for await (const raw of iterator) {
        if (remaining <= 0) break;
        const chunk = new Uint8Array(raw);
        const offset = Math.min(remainingSkip, chunk.length);
        remainingSkip -= offset;
        const take = Math.min(remaining, chunk.length - offset);
        if (take > 0) { yield chunk.subarray(offset, offset + take); remaining -= take; }
      }
      if (remaining > 0) throw new Error('Telegram media ended before the requested byte range was complete');
    } finally { await iterator.close(); }
  }
  return trim();
}

