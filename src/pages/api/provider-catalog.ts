import { getProvider, ordered } from '../../lib/providers';
import { ProviderError } from '../../lib/providers/types';
import { searchWithMetadata } from '../../lib/providers/anikoto';
import { searchAcrossProviders } from '../../lib/providers/search';
import { queryAniList } from '../../lib/anilist';
import { filterAndSortAnime, mergeProviderResults, type CatalogFilters, type FilterableAnime } from '../../lib/catalog-filters';
import { readJsonBody, RequestBodyError } from '../../lib/request-body';
import { withResourceLimit } from '../../lib/resource-limits';

export const prerender = false;

interface AniListMatch {
  id: number;
  title: { english?: string | null; romaji?: string | null; native?: string | null };
  coverImage?: { large?: string | null };
  startDate?: { year?: number | null; month?: number | null; day?: number | null };
  season?: string | null;
  seasonYear?: number | null;
  status?: string | null;
  format?: string | null;
  averageScore?: number | null;
  popularity?: number | null;
  genres?: string[];
  tags?: Array<{ name: string }>;
}

const animeMetadataCache = new Map<string, { until: number; items: AniListMatch[] }>();
const normalizeTitle = (value: string) => value.toLocaleLowerCase().normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

async function aniListMatches(query: string): Promise<AniListMatch[]> {
  const key = query.trim().toLocaleLowerCase();
  const cached = animeMetadataCache.get(key);
  if (cached && cached.until > Date.now()) return cached.items;
  const data = await queryAniList<{ Page: { media: AniListMatch[] } }>(
    'query ($search: String) { Page(page: 1, perPage: 50) { media(search: $search, type: ANIME, isAdult: false) { id title { english romaji native } coverImage { large } startDate { year month day } season seasonYear status format averageScore popularity genres tags { name } } } }',
    { search: query },
  );
  animeMetadataCache.set(key, { until: Date.now() + 10 * 60_000, items: data.Page.media });
  return data.Page.media;
}

function enrichResult(result: FilterableAnime, metadata: AniListMatch[]): FilterableAnime {
  const sourceNames = [...(typeof result.title === 'string' ? [result.title] : [result.title.english, result.title.romaji, result.title.native].filter((name): name is string => Boolean(name))), ...(result.alt ?? [])];
  const sourceKeys = sourceNames.map(normalizeTitle).filter(Boolean);
  const match = metadata.find(item => [item.title.english, item.title.romaji, item.title.native]
    .filter((name): name is string => Boolean(name))
    .map(normalizeTitle)
    .some(name => sourceKeys.includes(name)));
  if (!match) return result;
  const animeType = match.format ?? result.animeType ?? result.type;
  const year = match.startDate?.year ?? match.seasonYear ?? result.year;
  const releaseTimestamp = match.startDate?.year ? match.startDate.year * 10_000 + (match.startDate.month ?? 0) * 100 + (match.startDate.day ?? 0) : year ? year * 10_000 : result.releaseTimestamp;
  const type = animeType === 'MOVIE' ? 'Movie' : animeType === 'TV_SHORT' ? 'Short' : animeType;
  const genres = match.genres?.length ? match.genres : result.genres;
  const tags = match.tags?.map(tag => tag.name) ?? result.tags;
  return {
    ...result,
    title: match.title.english ?? match.title.romaji ?? match.title.native ?? result.title,
    image: result.image ?? match.coverImage?.large ?? result.cover,
    anilistId: match.id,
    ...(genres ? { genres } : {}),
    ...(tags ? { tags } : {}),
    ...(year ? { year, releaseDate: match.startDate?.year ? [match.startDate.year, match.startDate.month, match.startDate.day].filter(Boolean).join('-') : String(year) } : {}),
    ...(releaseTimestamp ? { releaseTimestamp } : {}),
    ...(match.season ? { season: match.season } : {}),
    ...(match.status ? { status: match.status } : {}),
    ...(match.averageScore != null ? { rating: match.averageScore / 10 } : {}),
    ...(match.popularity != null ? { popularity: match.popularity } : {}),
    ...(animeType ? { animeType } : {}),
    ...(type ? { type, format: animeType === 'TV' || animeType === 'ONA' ? 'SERIES' : animeType === 'MOVIE' ? 'MOVIE' : animeType === 'TV_SHORT' ? 'SHORT' : 'SPECIAL' } : {}),
  };
}

/** Search and episode lookup for providers implemented in this application. */
export async function GET({ request }: { request: Request }): Promise<Response> {
  const url = new URL(request.url);
  const providerId = url.searchParams.get('provider') ?? '';
  const action = url.searchParams.get('action') ?? 'search';
  if (providerId === 'all' && action === 'search') {
    const query = url.searchParams.get('q')?.trim().slice(0, 120) ?? '';
    if (!query) return Response.json({ results: [], providers: [] });
    const available = ordered();
    const aggregate = await searchAcrossProviders(query, available, 10_000, (provider, value) =>
      provider.id === 'anikoto' ? searchWithMetadata(value) : provider.searchByTitle(value),
    );
    const results = aggregate.results.map(hit => ({
      id: hit.id,
      title: hit.title,
      providerId: hit.providerId,
      ...(hit.alt?.length ? { alt: hit.alt } : {}),
      ...('image' in hit && hit.image ? { image: hit.image } : {}),
      ...('genres' in hit && hit.genres ? { genres: hit.genres } : {}),
      ...('format' in hit && hit.format ? { type: hit.format } : {}),
    }));
    if (!results.length && aggregate.providers.every(status => status.error)) {
      return Response.json({ error: 'all-providers-unavailable', providers: aggregate.providers.map(({ providerId: source, error }) => ({ provider: source, error })) }, { status: 502, headers: { 'cache-control': 'no-store' } });
    }
    return Response.json({ results, providers: aggregate.providers }, { headers: { 'cache-control': 'private, max-age=30' } });
  }
  const provider = getProvider(providerId);
  if (!provider || !['search', 'info'].includes(action)) {
    return Response.json({ error: 'unsupported-provider-action', provider: providerId, action }, { status: 400 });
  }

  try {
    if (action === 'search') {
      const query = url.searchParams.get('q')?.trim() ?? '';
      if (!query) return Response.json({ results: [] });
      const results = providerId === 'anikoto' ? await searchWithMetadata(query) : await provider.searchByTitle(query);
      return Response.json({ results: results.map(hit => ({
        id: hit.id,
        title: hit.title,
        ...(hit.alt?.length ? { alt: hit.alt } : {}),
        ...('image' in hit && hit.image ? { image: hit.image } : {}),
        ...('genres' in hit && hit.genres ? { genres: hit.genres } : {}),
        ...('format' in hit && hit.format ? { type: hit.format } : {}),
      })) });
    }

    const id = url.searchParams.get('id') ?? '';
    if (!id) return Response.json({ error: 'missing-series-id' }, { status: 400 });
    const episodes = await provider.listEpisodes(id);
    return Response.json({ id, title: id, episodes: episodes.map(episode => ({ id: episode.id, number: episode.num, title: `Episode ${episode.num}` })) });
  } catch (error) {
    const reason = error instanceof ProviderError ? error.kind : 'network';
    console.error({ provider: providerId, action, reason, message: error instanceof Error ? error.message : String(error) });
    return Response.json({ error: reason, provider: providerId }, { status: 502 });
  }
}

export async function POST({ request }: { request: Request }): Promise<Response> {
  let body: { provider?: string; query?: string; results?: FilterableAnime[]; filters?: CatalogFilters };
  try { body = await readJsonBody<typeof body>(request); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : 'invalid-json' }, { status: error instanceof RequestBodyError ? error.status : 400 }); }
  const provider = body.provider ?? '';
  const query = (body.query ?? '').trim().slice(0, 120);
  const results = Array.isArray(body.results) ? body.results.slice(0, 100) : [];
  if (!provider || !query || !results.length) return Response.json({ results: [], total: 0 });
  try {
    const metadata = await withResourceLimit('catalog-filter', () => aniListMatches(query), request.signal);
    const enriched = results.map(result => enrichResult(result, metadata));
    const filtered = mergeProviderResults(filterAndSortAnime(enriched, body.filters ?? {}));
    return Response.json({ results: filtered, total: filtered.length });
  } catch (error) {
    console.error({ provider, capability: 'catalog-filter', reason: error instanceof Error ? error.message : String(error) });
    return Response.json({ error: 'metadata-unavailable', diagnostic: 'AniList metadata could not be loaded for filtering.' }, { status: 502 });
  }
}
