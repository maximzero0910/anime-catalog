import { getTitles } from '../../../lib/db';
import { associateTelegramMessage, matchedTelegramEpisodes, rejectTelegramMatch, telegramAdminMessages, telegramStats, updateTelegramSyncState, upsertTelegramAlias } from '../../../lib/telegram/storage';
import { matchTelegramMessage } from '../../../lib/telegram/matching';

export const prerender = false;
function authorized(request: Request): boolean {
  const url = new URL(request.url); const host = url.hostname.toLowerCase();
  const loopback = host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
  const origin = request.headers.get('origin');
  return process.env.TELEGRAM_ADMIN_TOKEN ? request.headers.get('authorization') === `Bearer ${process.env.TELEGRAM_ADMIN_TOKEN}` : loopback && (!origin || origin === url.origin);
}
export async function GET({ request }: { request: Request }): Promise<Response> {
  if (!authorized(request)) return Response.json({ error: process.env.TELEGRAM_ADMIN_TOKEN ? 'unauthorized' : 'local administration requires loopback access' }, { status: process.env.TELEGRAM_ADMIN_TOKEN ? 401 : 503 });
  return Response.json({ status: telegramStats(), messages: telegramAdminMessages(), titles: getTitles().map(title => ({ id: title.id, name: title.english ?? title.romaji ?? title.native ?? String(title.id) })) }, { headers: { 'cache-control': 'no-store' } });
}
export async function POST({ request }: { request: Request }): Promise<Response> {
  if (!authorized(request)) return Response.json({ error: process.env.TELEGRAM_ADMIN_TOKEN ? 'unauthorized' : 'local administration requires loopback access' }, { status: process.env.TELEGRAM_ADMIN_TOKEN ? 401 : 503 });
  let body: Record<string, unknown>;
  try { body = await request.json() as Record<string, unknown>; } catch { return Response.json({ error: 'invalid-json' }, { status: 400 }); }
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

