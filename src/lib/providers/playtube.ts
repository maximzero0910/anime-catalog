import { getTitles } from '../db';
import { telegramAliases } from '../telegram/storage';
import { httpGet, type AudioMode, type EpisodeRef, type Provider, type SearchHit, type StreamSource } from './types';

export const BASE = 'https://playtube.tv';
export const CHANNEL = `${BASE}/@Belion`;
const id = 'playtube';
const cacheMs = 2 * 60_000;
interface Video { id: string; url: string; title: string; series: string; num: number; season: number | null; }
interface SearchCache { expires: number; videos: Video[]; }
const searchCache = new Map<string, SearchCache>();
const seriesCache = new Map<string, { expires: number; videos: Video[]; aliases: string[] }>();

const normalize = (value: string) => value.toLocaleLowerCase().normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
function htmlText(value: string): string {
  return value.replace(/<[^>]*>/g, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&#(\d+);/g, (_match, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([\da-f]+);/gi, (_match, n: string) => String.fromCodePoint(parseInt(n, 16))).replace(/\s+/g, ' ').trim();
}

export function parseVideoTitle(rawTitle: string, url: string, identifier: string): Video | null {
  const title = htmlText(rawTitle);
  const seasonEpisode = title.match(/(?:сезон|season)\s*(\d{1,2})\s*(?:епизод|episode|ep)\s*#?\s*(\d{1,3})/iu);
  const episode = seasonEpisode ?? title.match(/(?:епизод|episode|episod|\bep\.?|серия)\s*#?\s*(\d{1,3})/iu);
  if (!episode || /\b(?:част|part)\s*\d+/iu.test(title)) return null;
  const num = Number(episode[seasonEpisode ? 2 : 1]);
  if (!Number.isSafeInteger(num) || num < 1) return null;
  let series = `${title.slice(0, episode.index)} ${title.slice((episode.index ?? 0) + episode[0].length)}`;
  series = series.replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
    .replace(/\b(?:bg\s*subs?|бг\s*субтитри|bulgarian\s*subtitles?|субтитри|1080p|720p|480p|360p)\b/giu, ' ')
    .replace(/[-–—|:]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!series) return null;
  const season = seasonEpisode ? Number(seasonEpisode[1]) : null;
  if (season && season > 1 && !/(?:season|сезон)\s*\d+/iu.test(series)) series = `${series} Season ${season}`;
  return { id: identifier, url, title, series, num, season };
}

export function extractChannelVideos(html: string): Video[] {
  const starts = [...html.matchAll(/<div\b(?=[^>]*\bclass=["'][^"']*\bvideo-wrapper\b[^"']*["'])(?=[^>]*\bdata-identifier=["']([^"']+)["'])[^>]*>/gi)];
  const videos = new Map<string, Video>();
  for (let index = 0; index < starts.length; index++) {
    const start = starts[index]!;
    const end = starts[index + 1]?.index ?? html.length;
    const card = html.slice(start.index, end);
    const uploader = card.match(/(?:href=["']https?:\/\/playtube\.tv\/@([^"/?#]+)|data-load=["'][^"']*id=([^&"']+))/i);
    if ((uploader?.[1] ?? uploader?.[2] ?? '').toLowerCase() !== 'belion') continue;
    const href = card.match(/href=["'](https?:\/\/playtube\.tv\/watch\/[^"']+)["']/i)?.[1];
    const title = card.match(/<h\d\b[^>]*\btitle=["']([^"']+)["']/i)?.[1]
      ?? card.match(/<h\d\b[^>]*>[\s\S]*?<a\b[^>]*>([\s\S]*?)<\/a>/i)?.[1];
    if (!href || !title) continue;
    const parsed = parseVideoTitle(title, href.replace(/&amp;/g, '&'), start[1] ?? '');
    if (parsed) videos.set(parsed.id, parsed);
  }
  return [...videos.values()];
}

function requestedTitleTerms(query: string): string[] {
  const key = normalize(query);
  const title = getTitles().find(item => [item.english, item.romaji, item.native, item.title_bg].some(name => name && normalize(name) === key));
  if (!title) return [query];
  const aliases = telegramAliases().filter(item => item.anime_id === title.id).map(item => item.alias);
  return [...new Set([query, title.english, title.romaji, title.native, title.title_bg, ...aliases].filter((value): value is string => Boolean(value && value.trim())))].slice(0, 8);
}

async function searchVideos(term: string): Promise<Video[]> {
  const key = normalize(term);
  const cached = searchCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.videos;
  const result = await httpGet(`${BASE}/search?keyword=${encodeURIComponent(term)}`, { provider: id, referer: CHANNEL, timeoutMs: 12_000 });
  const videos = extractChannelVideos(result.text);
  searchCache.set(key, { expires: Date.now() + cacheMs, videos });
  return videos;
}

function seriesKey(series: string): string { return `playtube:${Buffer.from(normalize(series)).toString('base64url')}`; }
function decodeSeriesKey(value: string): string | null {
  if (!value.startsWith('playtube:')) return null;
  try { return Buffer.from(value.slice('playtube:'.length), 'base64url').toString('utf8'); } catch { return null; }
}

const playtube: Provider = {
  id,
  weight: Number(process.env.PLAYTUBE_PROVIDER_PRIORITY ?? 2),
  score: 1,
  async searchByTitle(query: string): Promise<SearchHit[]> {
    if (!query.trim()) return [];
    const terms = requestedTitleTerms(query);
    const videos = new Map<string, Video>();
    for (const term of terms) for (const video of await searchVideos(term)) videos.set(video.id, video);
    const grouped = new Map<string, Video[]>();
    for (const video of videos.values()) grouped.set(normalize(video.series), [...(grouped.get(normalize(video.series)) ?? []), video]);
    const hits: SearchHit[] = [];
    for (const [key, items] of grouped) {
      const series = items[0]!.series;
      const aliases = [...new Set([query, ...terms, series])];
      const hit: SearchHit = { id: seriesKey(series), title: series, alt: aliases.filter(alias => alias !== series) };
      seriesCache.set(hit.id, { expires: Date.now() + cacheMs, videos: items, aliases });
      if (key && normalize(series)) hits.push(hit);
    }
    return hits;
  },
  async listEpisodes(seriesId: string): Promise<EpisodeRef[]> {
    let cached = seriesCache.get(seriesId);
    if (!cached || cached.expires <= Date.now()) {
      const series = decodeSeriesKey(seriesId);
      if (!series) return [];
      const videos = await searchVideos(series);
      cached = { expires: Date.now() + cacheMs, videos: videos.filter(video => normalize(video.series) === series), aliases: [series] };
      seriesCache.set(seriesId, cached);
    }
    return cached.videos.map(video => ({ num: video.num, id: video.url })).sort((a, b) => a.num - b.num);
  },
  async resolve(episodeId: string, mode: AudioMode): Promise<StreamSource[]> {
    let episodeUrl: URL;
    try { episodeUrl = new URL(episodeId); } catch { return []; }
    if (episodeUrl.protocol !== 'https:' || episodeUrl.hostname !== 'playtube.tv' || !episodeUrl.pathname.startsWith('/watch/')) return [];
    const page = await httpGet(episodeUrl.href, { provider: id, referer: CHANNEL, timeoutMs: 12_000 });
    const media = page.text.match(/\bjw\.setup\s*\(\s*\{[\s\S]*?\bfile\s*:\s*["']([^"']+)["']/i)?.[1]?.replace(/\\\//g, '/');
    if (!media) return [];
    let mediaUrl: URL;
    try { mediaUrl = new URL(media, episodeUrl); } catch { return []; }
    if (mediaUrl.protocol !== 'https:' || !/(?:saphiracdn\.com|playtube\.tv)$/i.test(mediaUrl.hostname)) return [];
    const response = await httpGet(mediaUrl.href, { provider: id, referer: episodeUrl.href, timeoutMs: 10_000, retries: 1, method: 'HEAD' });
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    if (response.status < 200 || response.status >= 300 || !contentType.startsWith('video/')) return [];
    return [{ url: mediaUrl.href, type: 'mp4', quality: 'auto', headers: { referer: episodeUrl.href }, subtitles: [], audio: mode, provider: id }];
  },
  async health(): Promise<boolean> {
    try {
      const response = await httpGet(CHANNEL, { provider: id, retries: 0, timeoutMs: 8000 });
      return response.status >= 200 && response.status < 400 && response.text.includes('Belion');
    } catch { return false; }
  },
};

export default playtube;
