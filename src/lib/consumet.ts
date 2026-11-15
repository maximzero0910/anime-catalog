export interface ConsumetSearchResult { id: string; title: string | { english?: string; romaji?: string; native?: string }; image?: string; cover?: string; releaseDate?: string; type?: string; }
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

const apiBase = ['localhost', '127.0.0.1'].includes(window.location.hostname) ? '/api' : 'https://cdn.example.com/api';

async function request<T>(path: string): Promise<T> {
  let response: Response;
  try { response = await fetch(`${apiBase}${path}`); }
  catch { throw new ConsumetError('Worker API не е достъпен. Стартирай Wrangler на порт 8787.', 0); }
  const body = await response.json().catch(() => ({})) as ConsumetErrorPayload & T;
  if (!response.ok) throw new ConsumetError(body.diagnostic ?? body.error ?? `Consumet върна HTTP ${response.status}`, response.status, body);
  return body;
}

export const searchProvider = (provider: string, query: string) =>
  provider === 'anikoto'
    ? request<{ results?: ConsumetSearchResult[] }>(`/provider-catalog?${new URLSearchParams({ provider, action: 'search', q: query })}`)
    : request<{ results?: ConsumetSearchResult[] }>(`/anime/${encodeURIComponent(provider)}/${encodeURIComponent(query)}`);
export const getProviderAnime = (provider: string, id: string) =>
  provider === 'anikoto'
    ? request<ConsumetAnimeInfo>(`/provider-catalog?${new URLSearchParams({ provider, action: 'info', id })}`)
    : request<ConsumetAnimeInfo>(`/anime/${encodeURIComponent(provider)}/info?id=${encodeURIComponent(id)}`);
export async function getEpisodeStreams(provider: string, episodeId: string) {
  if (provider === 'anikoto') {
    const query = new URLSearchParams({ provider, episodeId, audio: 'sub' });
    const source = await request<{ url: string; type: string; quality: string; subtitles?: Array<{ url: string; lang?: string }> }>(`/provider-stream?${query}`);
    return {
      sources: [{ url: source.url, isM3U8: source.type === 'hls', quality: source.quality, type: source.type }],
      subtitles: source.subtitles ?? [],
    };
  }
  return request<{ sources?: ConsumetSource[]; subtitles?: Array<{ url: string; lang?: string }> }>(`/anime/${encodeURIComponent(provider)}/watch/${encodeURIComponent(episodeId)}`);
}

export function getSourceKind(source: ConsumetSource): 'hls' | 'dash' | 'mp4' | 'unsupported' {
  const url = source.url.toLowerCase().split('?')[0];
  const type = source.type?.toLowerCase() ?? '';
  if (source.isM3U8 || url.endsWith('.m3u8') || type.includes('mpegurl')) return 'hls';
  if (url.endsWith('.mpd') || type.includes('dash') || type.includes('dash+xml')) return 'dash';
  if (url.endsWith('.mp4') || type.includes('mp4')) return 'mp4';
  return 'unsupported';
}
