import { getAniListAnime } from '../../../lib/anilist';
import { getTitleById } from '../../../lib/db';
import { ordered } from '../../../lib/providers';
import { animeTitleForms } from '../../../lib/subtitles/match';
import { resolveSubtitleSource } from '../../../lib/subtitles/acquire';
import { subtitleOffsets, subtitleTitleAliases } from '../../../lib/subtitles/storage';
import { resolveProviderEpisode } from '../../../lib/providers/title-resolver';
import { adminAuthorized, adminTokenConfigured } from '../../../lib/admin-auth';

export const prerender = false;

export async function GET({ request }: { request: Request }): Promise<Response> {
  if (!adminAuthorized(request, process.env.SUBTITLE_ADMIN_TOKEN)) {
    const configured = adminTokenConfigured(process.env.SUBTITLE_ADMIN_TOKEN);
    return Response.json({ error: configured ? 'unauthorized' : 'debug endpoint disabled' }, {
      status: configured ? 401 : 503,
      headers: { 'cache-control': 'no-store', ...(configured ? { 'WWW-Authenticate': 'Bearer realm="anineko-admin"' } : {}) },
    });
  }
  const url = new URL(request.url); const animeId = Number(url.searchParams.get('animeId')); const episode = Number(url.searchParams.get('episode'));
  if (!Number.isSafeInteger(animeId) || animeId < 1 || !Number.isSafeInteger(episode) || episode < 1) return Response.json({ error: 'animeId and episode must be positive integers' }, { status: 400 });
  const metadata = await getAniListAnime(animeId).catch(() => null); const local = getTitleById(animeId);
  const names = metadata ? animeTitleForms(metadata) : [local?.romaji, local?.english, local?.native].filter((value): value is string => Boolean(value));
  const titleSet = { romaji: metadata?.title.romaji ?? local?.romaji ?? '', english: metadata?.title.english ?? local?.english ?? '', native: metadata?.title.native ?? local?.native ?? '', synonyms: metadata?.synonyms ?? [] };
  const streams: Array<{ provider: string; slug?: string; episodeId?: string; sourceUrl?: string; error?: string }> = [];
  for (const provider of ordered()) {
    try {
      const aliases = subtitleTitleAliases(animeId, provider.id).map(row => row.source_title);
      const result = await resolveProviderEpisode(provider, [...new Set([...aliases, ...names])], titleSet, aliases, episode);
      const sources = await provider.resolve(result.episode.id, 'sub');
      streams.push({ provider: provider.id, slug: result.hit.id, episodeId: result.episode.id, ...(sources[0] ? { sourceUrl: sources[0].url } : {}), ...(!sources.length ? { error: 'provider returned no stream sources' } : {}) });
    } catch (error) { streams.push({ provider: provider.id, error: error instanceof Error ? error.message : String(error) }); }
  }
  const subtitles: Array<Record<string, unknown>> = [];
  try {
    const candidates = await resolveSubtitleSource(animeId, episode);
    for (const sourceId of ['playtube', 'anima-pr', 'subsunacs']) {
      const found = candidates.filter(candidate => candidate.sourceId === sourceId);
      subtitles.push({ source: sourceId, query: names, candidates: found.map(source => ({ title: source.title, episode: source.episode, kind: source.kind, score: source.score, url: source.url || null, attribution: source.attribution })), error: found.length ? undefined : 'no subtitle candidates' });
    }
  } catch (error) { subtitles.push({ source: 'subtitleSources', query: names, candidates: [], error: error instanceof Error ? error.message : String(error) }); }
  return Response.json({ anilist: { matched: Boolean(metadata || local), titles: names }, streams, subtitles, offsets: subtitleOffsets(animeId, episode) }, { headers: { 'cache-control': 'no-store' } });
}
