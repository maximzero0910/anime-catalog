import { getTitles } from '../../../lib/db';
import { associateTelegramMessage, matchedTelegramEpisodes, rejectTelegramMatch, telegramAdminMessages, telegramStats, updateTelegramSyncState, upsertTelegramAlias } from '../../../lib/telegram/storage';
import { matchTelegramMessage } from '../../../lib/telegram/matching';
import { adminAuthorized, adminTokenConfigured } from '../../../lib/admin-auth';
import { workerHeartbeats } from '../../../lib/worker-heartbeat';
import { readJsonBody, RequestBodyError } from '../../../lib/request-body';
import { telegramMediaPoolStatus } from '../../../lib/telegram/client';

export const prerender = false;

function unauthorizedResponse(): Response {
  const configured = adminTokenConfigured(process.env.TELEGRAM_ADMIN_TOKEN);
  return Response.json(
    { error: configured ? 'unauthorized' : 'Set TELEGRAM_ADMIN_TOKEN to enable administration' },
    { status: configured ? 401 : 503, headers: { 'cache-control': 'no-store', ...(configured ? { 'WWW-Authenticate': 'Bearer realm="anineko-admin"' } : {}) } },
  );
}
export async function GET({ request }: { request: Request }): Promise<Response> {
  if (!adminAuthorized(request, process.env.TELEGRAM_ADMIN_TOKEN)) return unauthorizedResponse();
  return Response.json({ status: telegramStats(), mediaPool: telegramMediaPoolStatus(), worker: workerHeartbeats().find(item => item.worker === 'telegram-sync') ?? null, messages: telegramAdminMessages(), titles: getTitles().map(title => ({ id: title.id, name: title.english ?? title.romaji ?? title.native ?? String(title.id) })) }, { headers: { 'cache-control': 'no-store' } });
}
export async function POST({ request }: { request: Request }): Promise<Response> {
  if (!adminAuthorized(request, process.env.TELEGRAM_ADMIN_TOKEN)) return unauthorizedResponse();
  let body: Record<string, unknown>;
  try { body = await readJsonBody<Record<string, unknown>>(request, 64 * 1024); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : 'invalid-json' }, { status: error instanceof RequestBodyError ? error.status : 400 }); }
  try {
    if (body.action === 'sync') {
      if (!Boolean(telegramStats().connectionConfigured)) return Response.json({ error: 'Telegram credentials or channel are missing' }, { status: 503 });
      updateTelegramSyncState({ status: 'queued', lastError: null });
    } else if (body.action === 'associate') {
      const channelId = String(body.channelId ?? ''); const messageId = Number(body.messageId); const animeId = Number(body.animeId); const episode = Number(body.episode); const season = body.season === '' || body.season == null ? null : Number(body.season);
      if (!channelId || ![messageId, animeId, episode].every(Number.isSafeInteger)) return Response.json({ error: 'invalid-association' }, { status: 400 });
      associateTelegramMessage(channelId, messageId, animeId, episode, season, true);
    } else if (body.action === 'alias') {
      const animeId = Number(body.animeId); const alias = String(body.alias ?? '').trim();
      if (!Number.isSafeInteger(animeId) || !alias) return Response.json({ error: 'invalid-alias' }, { status: 400 });
      upsertTelegramAlias(animeId, alias);
      for (const row of matchedTelegramEpisodes()) matchTelegramMessage(row as unknown as Parameters<typeof matchTelegramMessage>[0]);
    } else if (body.action === 'reject') {
      const channelId = String(body.channelId ?? ''); const messageId = Number(body.messageId);
      if (!channelId || !Number.isSafeInteger(messageId)) return Response.json({ error: 'invalid-message' }, { status: 400 });
      if (!matchedTelegramEpisodes().some(item => item.channel_id === channelId && Number(item.message_id) === messageId)) return Response.json({ error: 'message-not-found' }, { status: 404 });
      rejectTelegramMatch(channelId, messageId);
    } else return Response.json({ error: 'unknown-action' }, { status: 400 });
    return Response.json({ ok: true, status: telegramStats() }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 }); }
}

