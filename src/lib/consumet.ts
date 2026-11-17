import type { CatalogFilters } from './catalog-filters';

export interface ConsumetSearchResult {
  id: string; alt?: string[];
  title: string | { english?: string; romaji?: string; native?: string };
  image?: string; cover?: string; releaseDate?: string; type?: string; genres?: string[];
  tags?: string[]; year?: number; releaseTimestamp?: number; season?: string; status?: string; rating?: number;
  popularity?: number; animeType?: string; format?: string; anilistId?: number; providerId?: string;
  providerChoices?: Array<{ providerId: string; id: string }>;
}
export interface ConsumetEpisode { id: string; number: number; title?: string; url?: string; }
export interface ConsumetSource { url: string; isM3U8?: boolean; quality?: string; type?: string; }
export interface ConsumetAnimeInfo { id: string; title: string; image?: string; description?: string; episodes?: ConsumetEpisode[]; }
export interface ConsumetErrorPayload { error?: string; diagnostic?: string; provider?: string; endpoint?: string; upstreamStatus?: number; }

export class ConsumetError extends Error {
  constructor(message: string, readonly status: number, readonly detail?: ConsumetErrorPayload) {
    super(message);
    this.name = 'ConsumetError';
  }
}

const isLocal = ['localhost', '127.0.0.1'].includes(window.location.hostname);
const apiBase = isLocal ? '/api' : 'https://cdn.example.com/api';

async function request<T>(path: string, options: { signal?: AbortSignal; direct?: boolean } = {}): Promise<T> {
  let response: Response;
  const base = options.direct ? '/api' : apiBase;
  try { response = await fetch(`${base}${path}`, { signal: options.signal }); }
  catch { throw new ConsumetError('Worker API не е достъпен. Стартирай Wrangler на порт 8787.', 0); }
  const body = await response.json().catch(() => ({})) as ConsumetErrorPayload & T;
  if (!response.ok) throw new ConsumetError(body.diagnostic ?? body.error ?? `Consumet върна HTTP ${response.status}`, response.status, body);
  return body;
}

export const searchProvider = (provider: string, query: string, signal?: AbortSignal) =>
  request<{ results?: ConsumetSearchResult[] }>(`/provider-catalog?${new URLSearchParams({ provider, action: 'search', q: query })}`, { signal, direct: true });

export const searchAllProviders = (query: string, signal?: AbortSignal) =>
  request<{ results?: ConsumetSearchResult[]; providers?: Array<{ providerId: string; count: number; error?: string }> }>(
    `/provider-catalog?${new URLSearchParams({ provider: 'all', action: 'search', q: query })}`, { signal, direct: true },
  );
export const getProviderAnime = (provider: string, id: string) =>
  request<ConsumetAnimeInfo>(`/provider-catalog?${new URLSearchParams({ provider, action: 'info', id })}`, { direct: true });
export async function getEpisodeStreams(provider: string, episodeId: string) {
  const query = new URLSearchParams({ provider, episodeId, audio: 'sub' });
  const source = await request<{ url: string; type: string; quality: string; subtitles?: Array<{ url: string; lang?: string }> }>(`/provider-stream?${query}`, { direct: true });
  return {
    sources: [{ url: source.url, isM3U8: source.type === 'hls', quality: source.quality, type: source.type }],
    subtitles: source.subtitles ?? [],
  };
}

export async function filterProviderResults(
  provider: string,
  query: string,
  results: ConsumetSearchResult[],
  filters: CatalogFilters,
  signal?: AbortSignal,
): Promise<{ results: ConsumetSearchResult[] }> {
  const response = await fetch('/api/provider-catalog?action=filter', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider, query, results, filters }),
    signal,
  });
  const body = await response.json().catch(() => ({})) as ConsumetErrorPayload & { results?: ConsumetSearchResult[] };
  if (!response.ok) throw new ConsumetError(body.diagnostic ?? body.error ?? `Филтрирането върна HTTP ${response.status}`, response.status, body);
  return { results: body.results ?? [] };
}

export function getSourceKind(source: ConsumetSource): 'hls' | 'dash' | 'mp4' | 'unsupported' {
  const url = source.url.toLowerCase().split('?')[0];
  const type = source.type?.toLowerCase() ?? '';
  if (source.isM3U8 || url.endsWith('.m3u8') || type.includes('mpegurl')) return 'hls';
  if (url.endsWith('.mpd') || type.includes('dash') || type.includes('dash+xml')) return 'dash';
  if (url.endsWith('.mp4') || type.includes('mp4')) return 'mp4';
  return 'unsupported';
}

