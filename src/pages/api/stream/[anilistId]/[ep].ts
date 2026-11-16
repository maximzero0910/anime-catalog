import { getTitleById } from '../../../../lib/db';
import { ordered, recordFailure, recordSuccess } from '../../../../lib/providers';
import { ProviderError, verifyPlayablePlaylist } from '../../../../lib/providers/types';
import { queryAniList } from '../../../../lib/anilist';
import providerMappings from '../../../../../data/provider-map.json';
import { getTelegramEpisode } from '../../../../lib/telegram/storage';
import telegramProvider from '../../../../lib/providers/telegram';
import { isUsableSubtitleTrackUrl } from '../../../../lib/subtitle-track-url';
import { getAniListAnime } from '../../../../lib/anilist';
import { subtitleTitleAliases } from '../../../../lib/subtitles/storage';
import { resolveProviderEpisode } from '../../../../lib/providers/title-resolver';

export const prerender = false;

export async function GET({ params, request }: { params: { anilistId?: string; ep?: string }; request: Request }): Promise<Response> {
  const anilistId = Number(params.anilistId);
  const episode = Number(params.ep);
  if (!Number.isSafeInteger(anilistId) || anilistId <= 0 || !Number.isSafeInteger(episode) || episode <= 0) {
    return Response.json({ error: 'invalid-episode' }, { status: 400 });
  }
  const telegramEpisode = getTelegramEpisode(anilistId, episode);
  const providerPriority = ordered().filter(provider => provider.id !== 'telegram');
  const telegramPriority = telegramProvider.weight * telegramProvider.score;
  const externalPriority = Math.max(0, ...providerPriority.map(provider => provider.weight * provider.score));
  const telegramFirst = Boolean(telegramEpisode && telegramPriority > 0 && telegramPriority >= externalPriority);
  const resolveTelegram = async (): Promise<Response | null> => {
    if (!telegramEpisode || telegramPriority <= 0) return null;
    try {
      const source = (await telegramProvider.resolve(String(telegramEpisode.message_id), 'sub'))[0];
      if (source) return Response.json({ url: source.url, type: source.type, quality: source.quality, headers: source.headers, subtitles: [], audio: source.audio, provider: source.provider, hardsub: 'bg' }, { headers: { 'cache-control': 'no-store' } });
    } catch (error) {
      console.warn({ provider: 'telegram', ep: episode, reason: error instanceof Error ? error.message : String(error) });
    }
    return null;
  };
  if (telegramFirst) { const source = await resolveTelegram(); if (source) return source; }
  let title = getTitleById(anilistId);
  let aniList = await getAniListAnime(anilistId).catch(() => null);
  if (!title) {
    try {
      const metadata = await queryAniList<{ Media?: { title?: { romaji?: string | null; english?: string | null; native?: string | null } } }>(
        'query ($id: Int) { Media(id: $id, type: ANIME) { title { romaji english native } } }', { id: anilistId },
      );
      const names = metadata.Media?.title;
      if (names) title = { id: anilistId, slug: String(anilistId), romaji: names.romaji ?? null, english: names.english ?? null, native: names.native ?? null, title_bg: null, synopsis_bg: null, year: null, format: null, episodes: null, cover: null, banner: null, status: null, score: null, season: null, genres: [], tags: [] };
    } catch { /* Treat unavailable AniList metadata as a missing title. */ }
  }
  if (!title) return Response.json({ error: 'title-not-found', anilistId }, { status: 404 });
  const mode = new URL(request.url).searchParams.get('audio') === 'dub' ? 'dub' : 'sub';
  const displayTitle = title.english ?? title.romaji ?? title.native ?? title.title_bg ?? String(anilistId);
  const sourceTitles = { romaji: aniList?.title.romaji ?? title.romaji ?? '', english: aniList?.title.english ?? title.english ?? '', native: aniList?.title.native ?? title.native ?? '', synonyms: aniList?.synonyms ?? [] };
  const attempts: Array<{ provider: string; reason: string }> = [];
  const mapping = (providerMappings as Record<string, { provider: string; episodes: Array<{ number: number; providerEpisodeId: string }> }>)[String(anilistId)];
  const providers = providerPriority;
  if (mapping) providers.sort((a, b) => Number(b.id === mapping.provider) - Number(a.id === mapping.provider));
  const resolveFromProvider = async (provider: (typeof providers)[number]) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([ (async () => {
      const mappedEpisode = mapping?.provider === provider.id ? mapping.episodes.find(item => item.number === episode) : undefined;
      let ref = mappedEpisode ? { num: episode, id: mappedEpisode.providerEpisodeId } : undefined;
      if (!ref) {
        const aliases = subtitleTitleAliases(anilistId, provider.id).map(item => item.source_title);
        const queries = [...new Set([...aliases, displayTitle, title.romaji, title.english, title.native].filter((item): item is string => Boolean(item)))];
        try { ref = (await resolveProviderEpisode(provider, queries, sourceTitles, aliases, episode)).episode; }
        catch (error) { throw new ProviderError('empty', provider.id, error instanceof Error ? error.message : 'empty search'); }
      }
      if (!ref) throw new ProviderError('empty', provider.id, 'episode not found');
      const sources = await provider.resolve(ref.id, mode);
      const source = sources.find(item => (item.type === 'hls' && /^https?:\/\//i.test(item.url)) || (provider.id === 'playtube' && item.type === 'mp4'));
      if (!source || (source.type === 'hls' && !await verifyPlayablePlaylist(source.url, source.headers))) {
        throw new ProviderError('empty', provider.id, 'empty or invalid HLS');
      }
      provider.score = Math.min(1, provider.score * 1.05);
      recordSuccess(provider.id);
      return source;
      })(), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ProviderError('timeout', provider.id, `${provider.id}: discovery exceeded 9 seconds`)), 9000);
      }) ]);
    } catch (error) {
      provider.score = Math.max(0, provider.score * 0.85);
      recordFailure(provider.id);
      const reason = error instanceof ProviderError ? `${error.kind}: ${error.message}` : error instanceof Error ? error.message : String(error);
      console.error({ provider: provider.id, ep: episode, reason });
      attempts.push({ provider: provider.id, reason });
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  try {
    const source = await Promise.any(providers.map(resolveFromProvider));
    if (source.provider === 'playtube' && source.type === 'mp4') {
      const proxy = new URL('/api/hls', new URL(request.url).origin);
      proxy.searchParams.set('u', source.url);
      proxy.searchParams.set('r', source.headers.referer ?? 'https://playtube.tv/');
      return Response.json({ url: `${proxy.pathname}${proxy.search}`, type: source.type, quality: source.quality, headers: {}, subtitles: [], audio: source.audio, provider: source.provider, hardsub: 'bg' }, { headers: { 'cache-control': 'no-store' } });
    }
    return Response.json({ url: source.url, type: source.type, quality: source.quality, headers: source.headers, subtitles: source.subtitles.filter(track => isUsableSubtitleTrackUrl(track.url)), audio: source.audio, provider: source.provider });
  } catch {
    if (!telegramFirst) { const source = await resolveTelegram(); if (source) return source; }
    return Response.json({ error: 'empty', anilistId, episode, attempts }, { status: 502 });
  }
}
