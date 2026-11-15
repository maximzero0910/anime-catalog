import { getTitleById } from '../../../../lib/db';
import { ordered, recordFailure, recordSuccess } from '../../../../lib/providers';
import { ProviderError, verifyPlayablePlaylist } from '../../../../lib/providers/types';
import { queryAniList } from '../../../../lib/anilist';
import providerMappings from '../../../../../data/provider-map.json';

export const prerender = false;

function titleMatch(title: string, candidates: Array<{ id: string; title: string; alt?: string[] }>) {
  const normalize = (value: string) => value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const expected = normalize(title);
  const exact = candidates.find(candidate => [candidate.title, ...(candidate.alt ?? [])].some(name => normalize(name) === expected));
  if (exact) return exact;
  return candidates
    .filter(candidate => [candidate.title, ...(candidate.alt ?? [])].some(name => normalize(name).includes(expected)))
    .sort((a, b) => Math.abs(normalize(a.title).length - expected.length) - Math.abs(normalize(b.title).length - expected.length))[0];
}

export async function GET({ params, request }: { params: { anilistId?: string; ep?: string }; request: Request }): Promise<Response> {
  const anilistId = Number(params.anilistId);
  const episode = Number(params.ep);
  if (!Number.isSafeInteger(anilistId) || anilistId <= 0 || !Number.isSafeInteger(episode) || episode <= 0) {
    return Response.json({ error: 'invalid-episode' }, { status: 400 });
  }
  let title = getTitleById(anilistId);
  if (!title) {
    try {
      const metadata = await queryAniList<{ Media?: { title?: { romaji?: string | null; english?: string | null; native?: string | null } } }>(
        'query ($id: Int) { Media(id: $id, type: ANIME) { title { romaji english native } } }', { id: anilistId },
      );
      const names = metadata.Media?.title;
      if (names) title = { id: anilistId, slug: String(anilistId), romaji: names.romaji ?? null, english: names.english ?? null, native: names.native ?? null, title_bg: null, synopsis_bg: null, year: null, format: null, episodes: null, cover: null, banner: null, status: null, score: null, season: null };
    } catch { /* Treat unavailable AniList metadata as a missing title. */ }
  }
  if (!title) return Response.json({ error: 'title-not-found', anilistId }, { status: 404 });
  const mode = new URL(request.url).searchParams.get('audio') === 'dub' ? 'dub' : 'sub';
  const displayTitle = title.english ?? title.romaji ?? title.native ?? title.title_bg ?? String(anilistId);
  const attempts: Array<{ provider: string; reason: string }> = [];
  const mapping = (providerMappings as Record<string, { provider: string; episodes: Array<{ number: number; providerEpisodeId: string }> }>)[String(anilistId)];
  const providers = ordered();
  if (mapping) providers.sort((a, b) => Number(b.id === mapping.provider) - Number(a.id === mapping.provider));

  for (const provider of providers) {
    try {
      const mappedEpisode = mapping?.provider === provider.id ? mapping.episodes.find(item => item.number === episode) : undefined;
      let ref = mappedEpisode ? { num: episode, id: mappedEpisode.providerEpisodeId } : undefined;
      if (!ref) {
        const hits = await provider.searchByTitle(displayTitle);
        const hit = titleMatch(displayTitle, hits);
        if (!hit) { recordFailure(provider.id); attempts.push({ provider: provider.id, reason: 'empty search' }); continue; }
        const episodes = await provider.listEpisodes(hit.id);
        ref = episodes.find(item => item.num === episode);
      }
      if (!ref) { recordFailure(provider.id); attempts.push({ provider: provider.id, reason: 'episode not found' }); continue; }
      const sources = await provider.resolve(ref.id, mode);
      const source = sources.find(item => item.type === 'hls' && /^https?:\/\//i.test(item.url));
      if (!source || !await verifyPlayablePlaylist(source.url, source.headers)) {
        provider.score = Math.max(0, provider.score * 0.85);
        recordFailure(provider.id);
        attempts.push({ provider: provider.id, reason: 'empty or invalid HLS' });
        continue;
      }
      provider.score = Math.min(1, provider.score * 1.05);
      recordSuccess(provider.id);
      return Response.json({ url: source.url, type: source.type, quality: source.quality, headers: source.headers, subtitles: source.subtitles, audio: source.audio, provider: source.provider });
    } catch (error) {
      recordFailure(provider.id);
      const reason = error instanceof ProviderError ? `${error.kind}: ${error.message}` : error instanceof Error ? error.message : String(error);
      console.error({ provider: provider.id, ep: episode, reason });
      attempts.push({ provider: provider.id, reason });
    }
  }
  return Response.json({ error: 'empty', anilistId, episode, attempts }, { status: 502 });
}
