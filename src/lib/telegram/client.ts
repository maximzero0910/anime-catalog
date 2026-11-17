import './config';
import { TelegramClient } from 'telegram';
import { randomUUID } from 'node:crypto';
import { StringSession } from 'telegram/sessions';
import { Api } from 'telegram/tl';
import bigInt from 'big-integer';
import type { EntityLike } from 'telegram/define';
import { TelegramOperationError, withTelegramDeadline } from './deadline';
import { BoundedClientPool } from './client-pool';
import { acquireTelegramSyncLease, getTelegramMessage, releaseTelegramSyncLease, renewTelegramSyncLease, saveTelegramMessage, telegramSyncCheckpoint, updateTelegramSyncState, type TelegramMessageRow } from './storage';
import { matchTelegramMessage } from './matching';

const numberEnv = Number(process.env.TG_API_ID ?? process.env.TELEGRAM_API_ID);
const apiHash = process.env.TG_API_HASH ?? process.env.TELEGRAM_API_HASH ?? '';
const sessionString = process.env.TG_SESSION ?? process.env.TELEGRAM_SESSION ?? '';
export const telegramChannel = process.env.TG_CHANNEL ?? process.env.TELEGRAM_CHANNEL ?? '';
const telegramOperationTimeoutMs = (() => {
  const configured = Number(process.env.TELEGRAM_OPERATION_TIMEOUT_MS ?? 30_000);
  return Number.isFinite(configured) ? Math.min(120_000, Math.max(5_000, Math.floor(configured))) : 30_000;
})();
type TelegramPurpose = 'media' | 'sync' | `media-stream-${number}`;
// Keep background sync separate so a stalled RPC can be interrupted without evicting playback sessions.
const clientPromises: Partial<Record<TelegramPurpose, Promise<TelegramClient>>> = {};
const activeClients: Partial<Record<TelegramPurpose, TelegramClient>> = {};
const clientDisconnections = new WeakMap<TelegramClient, Promise<void>>();
type TelegramVideo = { client: TelegramClient; channel: EntityLike; message: Api.Message & { media: Api.MessageMediaDocument & { document: Api.Document } }; row: TelegramMessageRow };
const mediaMessageCache = new Map<string, { expiresAt: number; value: TelegramVideo }>();

function boundedEnvInteger(name: string, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(process.env[name]);
  return Number.isSafeInteger(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

function interruptClient(client: TelegramClient): void {
  forgetClient(client);
  void closeTelegramClient(client);
}

function closeTelegramClient(client: TelegramClient): Promise<void> {
  let pending = clientDisconnections.get(client);
  if (!pending) {
    pending = Promise.resolve().then(() => client.disconnect()).then(() => undefined, () => undefined);
    clientDisconnections.set(client, pending);
  }
  return pending;
}

function forgetClient(client: TelegramClient): void {
  for (const purpose of Object.keys(activeClients) as TelegramPurpose[]) {
    if (activeClients[purpose] === client) {
      delete activeClients[purpose];
      delete clientPromises[purpose];
    }
  }
}

async function destroyTelegramClient(client: TelegramClient): Promise<void> {
  forgetClient(client);
  await closeTelegramClient(client);
}

function telegramOperation<T>(client: TelegramClient, name: string, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  return withTelegramDeadline(name, telegramOperationTimeoutMs, work, { signal, onInterrupt: () => interruptClient(client) });
}

const telegramMediaClientPool = new BoundedClientPool<TelegramClient>(
  boundedEnvInteger('TELEGRAM_MEDIA_CLIENTS', 2, 1, 4),
  boundedEnvInteger('TELEGRAM_MEDIA_MAX_WAITING', 4, 0, 32),
  boundedEnvInteger('TELEGRAM_MEDIA_WAIT_MS', 3000, 50, 30_000),
  (id, signal) => getTelegramClient(`media-stream-${id}`, signal),
  destroyTelegramClient,
);

export function telegramConfigured(): boolean { return Number.isSafeInteger(numberEnv) && numberEnv > 0 && apiHash.length >= 32 && sessionString.length >= 50 && !/(your_|placeholder|replace_me)/i.test(sessionString) && Boolean(telegramChannel); }
export async function getTelegramClient(purpose: TelegramPurpose = 'media', signal?: AbortSignal): Promise<TelegramClient> {
  if (!telegramConfigured()) throw new Error('Telegram is not configured; set TG_API_ID, TG_API_HASH, TG_SESSION, and TG_CHANNEL');
  if (!clientPromises[purpose]) {
    let connectionClient: TelegramClient | undefined;
    const connecting = (async () => {
      const client = new TelegramClient(new StringSession(sessionString), numberEnv, apiHash, { connectionRetries: 3, reconnectRetries: 3, autoReconnect: true, requestRetries: 2, floodSleepThreshold: 15 });
      connectionClient = client;
      activeClients[purpose] = client;
      await telegramOperation(client, 'connect', () => client.connect(), signal);
      if (!await telegramOperation(client, 'authorization check', () => client.checkAuthorization(), signal)) { await client.disconnect(); throw new Error('Telegram session is not authorized; create a GramJS StringSession before starting the service'); }
      return client;
    })();
    let attempt: Promise<TelegramClient>;
    attempt = connecting.catch(error => {
      if (connectionClient && activeClients[purpose] === connectionClient) delete activeClients[purpose];
      if (clientPromises[purpose] === attempt) delete clientPromises[purpose];
      throw error;
    });
    clientPromises[purpose] = attempt;
  }
  return clientPromises[purpose]!;
}
export async function disconnectTelegramClient(): Promise<void> {
  delete clientPromises.media;
  delete clientPromises.sync;
  mediaMessageCache.clear();
  const active = [activeClients.media, activeClients.sync].filter((client): client is TelegramClient => Boolean(client));
  delete activeClients.media;
  delete activeClients.sync;
  await telegramMediaClientPool.close();
  await Promise.all(active.map(client => closeTelegramClient(client)));
}
export function telegramMediaPoolStatus(): { size: number; active: number; waiting: number; closed: boolean } { return telegramMediaClientPool.snapshot(); }
export async function getTelegramChannel(client?: TelegramClient, signal?: AbortSignal): Promise<EntityLike> {
  const activeClient = client ?? await getTelegramClient();
  return await telegramOperation(activeClient, 'channel lookup', () => activeClient.getEntity(telegramChannel), signal);
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
async function fetchTelegramVideo(messageId: number, clientOverride?: TelegramClient): Promise<TelegramVideo> {
  const client = clientOverride ?? await getTelegramClient('media');
  const channel = await getTelegramChannel(client);
  const messages = await telegramOperation(client, 'message lookup', () => client.getMessages(channel, { ids: [messageId] }));
  const message = messages[0];
  if (!message || !(message instanceof Api.Message) || !isVideoMessage(message)) throw new Error(`Telegram video message ${messageId} no longer exists or is unavailable`);
  const channelId = String((channel as { id?: unknown }).id ?? telegramChannel);
  return { client, channel, message, row: messageToIndexRow(channelId, message) };
}
async function freshTelegramVideoForPurpose(messageId: number, purpose: TelegramPurpose, client?: TelegramClient, forceRefresh = false): Promise<TelegramVideo> {
  const key = `${purpose}:${messageId}`;
  const cached = mediaMessageCache.get(key);
  if (!forceRefresh && cached && cached.expiresAt > Date.now()) return cached.value;
  if (forceRefresh) mediaMessageCache.delete(key);
  const value = await fetchTelegramVideo(messageId, client);
  if (mediaMessageCache.size >= 500) {
    const now = Date.now();
    for (const [id, entry] of mediaMessageCache) if (entry.expiresAt <= now) mediaMessageCache.delete(id);
    while (mediaMessageCache.size >= 500) mediaMessageCache.delete(mediaMessageCache.keys().next().value!);
  }
  mediaMessageCache.set(key, { value, expiresAt: Date.now() + 30_000 });
  return value;
}
export async function freshTelegramVideo(messageId: number, forceRefresh = false): Promise<TelegramVideo> {
  return freshTelegramVideoForPurpose(messageId, 'media', undefined, forceRefresh);
}

export async function synchronizeTelegramChannel(signal?: AbortSignal): Promise<{ scanned: number; newVideos: number; matched: number; ambiguous: number; unmatched: number }> {
  const leaseOwner = randomUUID();
  if (!acquireTelegramSyncLease(leaseOwner)) throw new Error('Telegram sync is already running in another process');
  let leaseLost = false;
  const renewLease = () => {
    try { if (!renewTelegramSyncLease(leaseOwner)) leaseLost = true; }
    catch { leaseLost = true; }
  };
  const leaseTimer = setInterval(renewLease, 30_000);
  leaseTimer.unref();
  const totals = { scanned: 0, newVideos: 0, matched: 0, ambiguous: 0, unmatched: 0 };
  let checkpoint = telegramSyncCheckpoint();
  try {
    const client = await getTelegramClient('sync', signal);
    const channel = await getTelegramChannel(client, signal);
    if (leaseLost) throw new Error('Telegram sync lease was lost');
    const entity = channel as { id?: unknown; title?: string };
    const channelId = String(entity.id ?? telegramChannel);
    updateTelegramSyncState({ channel: telegramChannel, channelId, channelName: entity.title ?? telegramChannel, status: 'syncing', lastError: null });
    const initial = checkpoint;
    const iterator = client.iterMessages(channel, { minId: initial, reverse: true })[Symbol.asyncIterator]();
    try {
      while (true) {
        const next = await telegramOperation(client, 'message page', () => iterator.next(), signal);
        if (next.done) break;
        const message = next.value;
        if (leaseLost) throw new Error('Telegram sync lease was lost');
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
        // DECISION: checkpoint every 25 messages to reduce synchronous SQLite writes on the Pi; replay is idempotent by Telegram message ID.
        if (totals.scanned % 25 === 0) updateTelegramSyncState({ checkpoint, progress: totals.scanned });
      }
    } finally {
      void Promise.resolve(iterator.return?.()).catch(() => undefined);
    }
    if (leaseLost) throw new Error('Telegram sync lease was lost');
    if (signal?.aborted) {
      updateTelegramSyncState({ checkpoint, status: 'idle', progress: 0, lastError: null });
      return totals;
    }
    updateTelegramSyncState({ checkpoint, status: 'idle', progress: 0, lastSuccess: new Date().toISOString(), lastError: null });
    return totals;
  } catch (error) {
    if (!leaseLost && signal?.aborted && error instanceof TelegramOperationError && error.kind === 'cancelled') {
      updateTelegramSyncState({ checkpoint, status: 'idle', progress: 0, lastError: null });
    } else if (!leaseLost) updateTelegramSyncState({ status: 'failed', lastError: error instanceof Error ? error.message : String(error) });
    throw error;
  } finally {
    clearInterval(leaseTimer);
    releaseTelegramSyncLease(leaseOwner);
  }
}

export async function telegramVideoRange(messageId: number, start: number, end: number, forceRefresh = false, signal?: AbortSignal): Promise<AsyncIterable<Uint8Array>> {
  async function* trim(): AsyncGenerator<Uint8Array> {
    const lease = await telegramMediaClientPool.acquire(signal);
    const purpose: TelegramPurpose = `media-stream-${lease.id}`;
    let iterator: ReturnType<TelegramClient['iterDownload']> | undefined;
    let retireClient = false;
    try {
      const { client, channel, message } = await freshTelegramVideoForPurpose(messageId, purpose, lease.value, forceRefresh);
      const document = message.media.document;
      const chunkSize = 512 * 1024;
      const alignedStart = Math.floor(start / chunkSize) * chunkSize;
      let remainingSkip = start - alignedStart;
      let remaining = end - start + 1;
      const requested = end - alignedStart + 1;
      const limit = Math.ceil(requested / chunkSize);
      iterator = client.iterDownload({ file: message.media, offset: bigInt(alignedStart), limit, chunkSize, requestSize: chunkSize, fileSize: bigInt(Number(document.size)), dcId: document.dcId, msgData: [channel, messageId] });
      const downloadIterator = iterator[Symbol.asyncIterator]();
      while (true) {
        const next = await telegramOperation(client, 'media chunk', () => downloadIterator.next(), signal);
        if (next.done) break;
        const raw = next.value;
        if (remaining <= 0) break;
        const chunk = new Uint8Array(raw);
        const offset = Math.min(remainingSkip, chunk.length);
        remainingSkip -= offset;
        const take = Math.min(remaining, chunk.length - offset);
        if (take > 0) { yield chunk.subarray(offset, offset + take); remaining -= take; }
      }
      if (remaining > 0) throw new Error('Telegram media ended before the requested byte range was complete');
    } catch (error) {
      if (error instanceof TelegramOperationError || signal?.aborted) retireClient = true;
      throw error;
    } finally {
      if (iterator) {
        if (retireClient) void iterator.close().catch(() => undefined);
        else {
          try { await telegramOperation(lease.value, 'media cleanup', () => iterator!.close()); }
          catch { retireClient = true; }
        }
      }
      if (retireClient) {
        mediaMessageCache.delete(`${purpose}:${messageId}`);
        await lease.invalidate();
      }
      lease.release();
    }
  }
  return trim();
}

