import { getSubtitleOffset, setSubtitleOffset } from '../../../../../lib/subtitles/storage';

export const prerender = false;
const validSource = (value: string) => /^[a-z0-9][a-z0-9-]{0,63}$/i.test(value);

export async function GET({ params, request }: { params: { animeId?: string; episode?: string }; request: Request }): Promise<Response> {
  const animeId = Number(params.animeId); const episode = Number(params.episode); const sourceId = new URL(request.url).searchParams.get('sourceId') ?? 'default';
  if (!Number.isSafeInteger(animeId) || animeId < 1 || !Number.isSafeInteger(episode) || episode < 1 || !validSource(sourceId)) return Response.json({ error: 'invalid offset key' }, { status: 400 });
  return Response.json({ animeId, episode, sourceId, offset_ms: getSubtitleOffset(animeId, episode, sourceId) }, { headers: { 'cache-control': 'no-store' } });
}

export async function PATCH({ params, request }: { params: { animeId?: string; episode?: string }; request: Request }): Promise<Response> {
  const animeId = Number(params.animeId); const episode = Number(params.episode);
  let body: { sourceId?: unknown; offset_ms?: unknown };
  try { body = await request.json() as typeof body; } catch { return Response.json({ error: 'invalid JSON' }, { status: 400 }); }
  const sourceId = String(body.sourceId ?? 'default'); const offset = Number(body.offset_ms);
  if (!Number.isSafeInteger(animeId) || animeId < 1 || !Number.isSafeInteger(episode) || episode < 1 || !validSource(sourceId) || !Number.isInteger(offset) || Math.abs(offset) > 120_000) return Response.json({ error: 'invalid offset key or value' }, { status: 400 });
  setSubtitleOffset(animeId, episode, sourceId, offset);
  return Response.json({ animeId, episode, sourceId, offset_ms: getSubtitleOffset(animeId, episode, sourceId) }, { headers: { 'cache-control': 'no-store' } });
}
