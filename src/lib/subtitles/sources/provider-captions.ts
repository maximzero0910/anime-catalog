import { getProvider } from '../../providers';
import type { Provider, StreamSource } from '../../providers/types';
import { resolveProviderEpisode } from '../../providers/title-resolver';
import { fetchPublic } from '../../hls-proxy';
import { isUsableSubtitleTrackUrl } from '../../subtitle-track-url';
import type { Candidate } from './index';

export interface ProviderCaptionTitles {
  romaji: string;
  english: string;
  native: string;
  synonyms: string[];
}

export type CaptionFetcher = (url: string, referer: string, signal: AbortSignal) => Promise<{ body: string; format: 'srt' | 'ass' | 'ssa' | 'vtt'; language: string }>;

function languageCode(label: string): 'bg' | 'en' | 'ja' | null {
  const value = label.trim().toLowerCase();
  if (/^(bg|bul|bulgarian)(?:\b|\s)/.test(value)) return 'bg';
  if (/^(en|eng|english)(?:\b|\s)/.test(value)) return 'en';
  if (/^(ja|jpn|japanese|nihongo)(?:\b|\s)/.test(value)) return 'ja';
  return null;
}

async function fetchProviderCaption(url: string, referer: string, signal: AbortSignal): Promise<{ body: string; format: 'srt' | 'ass' | 'ssa' | 'vtt'; language: string }> {
  const target = new URL(url);
  if (target.protocol !== 'https:' || target.username || target.password || !target.hostname) throw new Error('provider caption URL is invalid');
  const response = await fetchPublic(target, { headers: referer ? { referer } : {} }, [], signal, {
    // DECISION: this URL came from a server-selected, registered stream adapter; retain the proxy's DNS pinning,
    // private-address rejection, redirect validation, timeout, and response cap without a wildcard hostname rule.
    manifestAuthorizedTarget: true,
    maxResponseBytes: 8 * 1024 * 1024,
    requestTimeoutMs: 15_000,
    totalTimeoutMs: 30_000,
  });
  if (!response.ok) throw new Error(`provider caption returned HTTP ${response.status}`);
  const body = new TextDecoder().decode(await response.arrayBuffer());
  if (Buffer.byteLength(body) < 20) throw new Error('provider caption body is empty');
  const pathname = target.pathname.toLowerCase();
  const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
  const format = (pathname.match(/\.(srt|ass|ssa|vtt)$/)?.[1]
    ?? (contentType.includes('subrip') ? 'srt' : contentType.includes('ass') ? 'ass' : contentType.includes('webvtt') ? 'vtt' : 'vtt')) as 'srt' | 'ass' | 'ssa' | 'vtt';
  return { body, format, language: '' };
}

export function candidatesFromProviderSources(
  providerId: string,
  episode: number,
  sources: StreamSource[],
  fetcher: CaptionFetcher = fetchProviderCaption,
): Candidate[] {
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  const rankedSources = sources.map((source, sourceIndex) => ({ source, sourceIndex }))
    .sort((left, right) => {
      const preference = (source: StreamSource): number => {
        const labels = source.subtitles.map(track => track.lang.toLowerCase());
        if (labels.some(label => /\bforced\b/.test(label))) return 2;
        if (labels.some(label => /\bsd[h]?(?:\b|$)|\bcc\b/.test(label))) return 1;
        return 0;
      };
      return preference(left.source) - preference(right.source) || left.sourceIndex - right.sourceIndex;
    });
  const bestByLanguage = new Map<'bg' | 'en' | 'ja', { source: StreamSource; track: StreamSource['subtitles'][number]; rank: number }>();
  for (const { source } of rankedSources) {
    if (source.type !== 'hls') continue;
    for (const track of source.subtitles) {
      const language = languageCode(track.lang);
      if (!language || !isUsableSubtitleTrackUrl(track.url) || seen.has(`${language}:${track.url}`)) continue;
      let target: URL;
      try { target = new URL(track.url); } catch { continue; }
      if (target.protocol !== 'https:' || target.username || target.password) continue;
      const rank = /\bforced\b/i.test(track.lang) ? 2 : /\bsd[h]?(?:\b|$)|\bcc\b/i.test(track.lang) ? 1 : 0;
      const current = bestByLanguage.get(language);
      if (!current || rank < current.rank) bestByLanguage.set(language, { source, track, rank });
    }
  }
  for (const [language, { source, track }] of bestByLanguage) {
    const target = new URL(track.url);
    seen.add(`${language}:${track.url}`);
    const format = track.format === 'ass' || track.format === 'srt' ? track.format : 'vtt';
    candidates.push({
      sourceId: `stream-${providerId}`,
      title: `${providerId} provider captions`,
      episode,
      url: target.href,
      kind: 'file',
      language,
      format,
      attribution: `${providerId} stream subtitles (${track.lang})`,
      fetch: async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 35_000);
        try {
          const file = await fetcher(target.href, source.headers.referer ?? `${new URL(source.url).origin}/`, controller.signal);
          return { ...file, language };
        } finally { clearTimeout(timer); }
      },
    });
  }
  return candidates;
}

export async function searchProviderCaptions(
  query: string,
  animeId: number,
  episode: number,
  titles: ProviderCaptionTitles,
  aliases: string[] = [],
  providers: Provider[] = ['9anime', 'anikoto'].map(id => getProvider(id)).filter((provider): provider is Provider => Boolean(provider)),
  fetcher: CaptionFetcher = fetchProviderCaption,
): Promise<Candidate[]> {
  const queries = [...new Set([query, ...aliases, titles.english, titles.romaji, titles.native, ...titles.synonyms].map(value => value.trim()).filter(Boolean))].slice(0, 3);
  const failures: string[] = [];
  const tracks: Candidate[] = [];
  for (const provider of providers) {
    if (!['9anime', 'anikoto'].includes(provider.id)) continue;
    try {
      const resolved = await resolveProviderEpisode(provider, queries, titles, aliases, episode);
      const sources = await provider.resolve(resolved.episode.id, 'sub');
      tracks.push(...candidatesFromProviderSources(provider.id, episode, sources, fetcher));
    } catch (error) {
      failures.push(`${provider.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!tracks.length && failures.length) throw new Error(failures.join('; '));
  return tracks;
}
