const endpoint = 'https://graphql.anilist.co';
export interface AniListAnime {
  id: number;
  episodes: number | null;
  synonyms: string[];
  title: { romaji: string | null; english: string | null; native: string | null };
}

const animeCache = new Map<number, { expiresAt: number; value: AniListAnime | null }>();
const animeRequests = new Map<number, Promise<AniListAnime | null>>();
const ANIME_CACHE_TTL_MS = 15 * 60_000;
const ANIME_CACHE_LIMIT = 512;

export async function queryAniList<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error(`AniList GraphQL returned ${response.status}`);
  const result = await response.json() as { data: T };
  return result.data;
}

export async function getAniListAnime(id: number): Promise<AniListAnime | null> {
  const cached = animeCache.get(id);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const pending = animeRequests.get(id);
  if (pending) return pending;

  const request = queryAniList<{ Media: AniListAnime | null }>(
    'query ($id: Int) { Media(id: $id, type: ANIME) { id episodes synonyms title { romaji english native } } }',
    { id },
  ).then(data => {
    const value = data.Media;
    if (animeCache.size >= ANIME_CACHE_LIMIT) {
      const oldest = animeCache.keys().next().value;
      if (oldest !== undefined) animeCache.delete(oldest);
    }
    animeCache.set(id, { expiresAt: Date.now() + ANIME_CACHE_TTL_MS, value });
    return value;
  }).finally(() => animeRequests.delete(id));
  animeRequests.set(id, request);
  return request;
}
