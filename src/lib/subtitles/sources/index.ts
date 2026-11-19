import { httpGet } from '../../providers/types';
import { extractChannelVideos, BASE as PLAYTUBE_BASE, CHANNEL as PLAYTUBE_CHANNEL } from '../../providers/playtube';
import { crawlAniMaCatalog, providerForSubtitleIndex, type SubtitleAnimeIds, type SubtitleCandidate } from '../index-providers';
import { scoreTitleMatch } from '../match';
import { subtitleTitleAliases, queueNeedsMapping } from '../storage';
import { searchProviderCaptions, type ProviderCaptionTitles } from './provider-captions';

export type LegacySourceId = 'playtube' | 'anima-pr' | 'subsunacs';

export interface Candidate {
  sourceId: string;
  title: string;
  episode: number;
  url: string;
  kind: 'file' | 'hardsub' | 'catalog';
  format?: 'srt' | 'ass' | 'ssa' | 'vtt';
  language?: string;
  attribution: string;
  fetch?: () => Promise<{ body: string; format: 'srt' | 'ass' | 'ssa' | 'vtt'; language: string }>;
}

const hostLastRequest = new Map<string, number>();
async function polite<T>(host: string, task: () => Promise<T>): Promise<T> {
  const wait = 1500 - (Date.now() - (hostLastRequest.get(host) ?? 0));
  if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
  try { return await task(); } finally { hostLastRequest.set(host, Date.now()); }
}
export async function searchTitles(sourceId: LegacySourceId, query: string, animeId: number, episode: number, titles: { romaji: string; english: string; native: string; synonyms: string[] }): Promise<Candidate[]> {
  const aliasRows = subtitleTitleAliases(animeId, sourceId);
  const knownAliases = aliasRows.map(row => row.source_title);
  const score = (title: string) => scoreTitleMatch(titles, title, knownAliases);
  if (sourceId === 'playtube') {
    return polite('playtube.tv', async () => {
      const result = await httpGet(`${PLAYTUBE_BASE}/search?keyword=${encodeURIComponent(query)}`, { provider: 'playtube', referer: PLAYTUBE_CHANNEL, timeoutMs: 12000, retries: 1 });
      const videos = extractChannelVideos(result.text);
      return videos.filter(video => video.num === episode).map((video): Candidate => ({ sourceId, title: video.series, episode: video.num, url: video.url, kind: 'hardsub', attribution: 'PlayTube · Belion' })).filter(candidate => {
        const value = score(candidate.title);
        if (value < 85) queueNeedsMapping({ animeId, episode, sourceId, sourceTitle: candidate.title, candidateUrl: candidate.url, score: value, reason: 'PlayTube title did not meet the automatic match threshold' });
        return value >= 85;
      });
    });
  }
  if (sourceId === 'anima-pr') {
    return polite('anima-pr.blogspot.com', async () => {
      const entries = await crawlAniMaCatalog();
      const candidates: Candidate[] = [];
      for (const entry of entries) {
        const value = score(entry.title);
        if (value < 85 && !entry.aliases.some(alias => score(alias) >= 85)) {
          if (value >= 50) queueNeedsMapping({ animeId, episode, sourceId, sourceTitle: entry.title, candidateUrl: entry.url, score: value, reason: 'AniMa catalog title needs manual mapping' });
          continue;
        }
        const url = await subtitleLink(entry.url);
        if (url) candidates.push({ sourceId, title: entry.title, episode, url, kind: 'file', format: url.match(/\.(srt|ass|ssa|vtt)(?:$|[?#])/i)?.[1]?.toLowerCase() as Candidate['format'], language: 'bg', attribution: `AniMa BG Fansubs · ${entry.title}` });
        else candidates.push({ sourceId, title: entry.title, episode, url: entry.url, kind: 'hardsub', attribution: `AniMa BG Fansubs · ${entry.title}` });
      }
      return candidates;
    });
  }
  return polite('subsunacs.net', async () => {
    const provider = providerForSubtitleIndex('subsunacs');
    if (!provider) return [];
    const result: Candidate[] = [];
    for (const title of [...new Set([query, ...knownAliases])]) {
      const context: SubtitleAnimeIds = { animeId: String(animeId), title, aliases: [titles.romaji, titles.english, titles.native, ...titles.synonyms, ...knownAliases].filter(Boolean), episode };
      const rows = await provider.search(context, null, episode);
      for (const row of rows.filter(item => item.episodeNumber === episode && item.language === 'bg')) {
        const sourceTitle = String(row.providerRef?.filename ?? title); const value = score(sourceTitle);
        if (value < 85) { queueNeedsMapping({ animeId, episode, sourceId, sourceTitle, candidateUrl: row.sourceUrl, score: value, reason: 'SubsUnacs result needs manual title mapping' }); continue; }
        result.push({ sourceId, title: sourceTitle, episode, url: row.sourceUrl ?? '', kind: 'file', language: row.language, format: (row.format as Candidate['format']) ?? 'srt', attribution: String(row.attribution ?? 'SubsUnacs'), fetch: () => provider.fetch(row) });
      }
    }
    return result;
  });
}

export async function subtitleLink(postUrl: string): Promise<string | null> {
  const response = await polite('anima-pr.blogspot.com', () => httpGet(postUrl, { provider: 'anima-pr', referer: 'https://anima-pr.blogspot.com/', timeoutMs: 12000, retries: 1 }));
  const links = [...response.text.matchAll(/(?:href|src)=["']([^"']+\.(?:vtt|srt)(?:\?[^"']*)?)["']/gi)].map(match => new URL(match[1]!, postUrl).href);
  return links.find(url => new URL(url).protocol === 'https:') ?? null;
}

export function episodeUrl(candidate: Candidate, episode: number): string | null {
  return candidate.episode === episode && candidate.url ? candidate.url : null;
}

export const subtitleSources = {
  playtube: { id: 'playtube', searchTitles: (query: string, animeId: number, episode: number, titles: { romaji: string; english: string; native: string; synonyms: string[] }) => searchTitles('playtube', query, animeId, episode, titles), episodeUrl },
  'anima-pr': { id: 'anima-pr', searchTitles: (query: string, animeId: number, episode: number, titles: { romaji: string; english: string; native: string; synonyms: string[] }) => searchTitles('anima-pr', query, animeId, episode, titles), episodeUrl },
  subsunacs: { id: 'subsunacs', searchTitles: (query: string, animeId: number, episode: number, titles: { romaji: string; english: string; native: string; synonyms: string[] }) => searchTitles('subsunacs', query, animeId, episode, titles), episodeUrl },
  'provider-captions': { id: 'provider-captions', searchTitles: (query: string, animeId: number, episode: number, titles: ProviderCaptionTitles, aliases: string[] = []) => searchProviderCaptions(query, animeId, episode, titles, aliases) },
} as const;
