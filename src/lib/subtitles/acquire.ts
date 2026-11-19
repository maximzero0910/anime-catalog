import { getTitleById } from '../db';
import { httpGet } from '../providers/types';
import { getAniListAnime } from '../anilist';
import { subtitleTitleAliases } from './storage';
import { animeTitleForms, scoreTitleMatch } from './match';
import { subtitleSources, type Candidate } from './sources';
import { subtitleIndexProviders, type SubtitleCandidate, type SubtitleIndexProvider, type SubtitleAnimeIds } from './index-providers';
import { searchAllSubtitleProviders, type SubtitleProviderSearchResult } from './provider-fallback';
import type { SourceLanguage } from './types';
import { parseSubtitle, type NormalizedSubtitle } from './normalize';

export interface SubtitleTrack {
  language: SourceLanguage | 'bg' | string;
  url: string;
  format: 'srt' | 'ass' | 'ssa' | 'vtt';
  provider: string;
  headers: Record<string, string>;
  attribution?: string;
  fetch?: Candidate['fetch'];
}
export interface SourceCandidate extends Candidate { provider: string; providerId: string; score: number; fileHash?: string | null; releaseGroup?: string | null; filename?: string | null; providerAlternates?: SourceCandidate[]; }

export interface SubtitleDiscoveryResult {
  candidates: SourceCandidate[];
  checkedProviders: string[];
  emptyProviders: string[];
  errors: Array<{ provider: string; reason: string }>;
  state: SubtitleProviderSearchResult<SourceCandidate>['state'];
  primaryProvider: string | null;
  primaryEmpty: boolean;
  exhaustedAllProviders: boolean;
}

export interface TrackAttemptFailure { provider: string; language: string; reason: string; }
export interface UsableTrackResult {
  track?: SubtitleTrack;
  downloaded?: Awaited<ReturnType<typeof downloadTrack>>;
  parsed?: NormalizedSubtitle;
  failures: TrackAttemptFailure[];
}

type SearchAdapter = {
  id: string;
  isEnabled(): boolean;
  search(): Promise<SourceCandidate[]>;
};

function indexedCandidate(provider: SubtitleIndexProvider, row: SubtitleCandidate): SourceCandidate {
  const title = String(row.providerRef?.animeTitle ?? row.providerRef?.filename ?? row.filename ?? row.providerRef?.fileId ?? row.providerId);
  return {
    sourceId: provider.id, provider: provider.id, providerId: row.providerId, title, episode: row.episodeNumber, url: row.sourceUrl ?? '',
    kind: row.catalogOnly ? 'catalog' : 'file', format: row.format as Candidate['format'] ?? undefined,
    language: row.language, attribution: row.attribution ?? provider.id,
    // SubtitleIndexInput.fileHash is the matched video hash, not the subtitle body hash; body dedupe happens after download.
    fileHash: null, releaseGroup: row.releaseGroup, filename: row.filename ?? String(row.providerRef?.filename ?? ''),
    fetch: row.catalogOnly ? undefined : async () => {
      const file = await provider.fetch(row);
      return { body: file.body, format: file.format, language: file.language };
    },
    score: 100,
  };
}

function dedupeProviderResults(result: SubtitleProviderSearchResult<SourceCandidate>, titles: { romaji: string; english: string; native: string; synonyms: string[] }, aliases: string[]): SourceCandidate[] {
  const unique = new Map<string, SourceCandidate>();
  const expanded = result.candidates.flatMap(candidate => [candidate, ...(candidate.providerAlternates as SourceCandidate[] | undefined ?? [])]);
  for (const candidate of expanded) {
    if (candidate.kind !== 'catalog' && !candidate.url && !candidate.fetch) continue;
    const score = candidate.score || scoreTitleMatch(titles, candidate.title, aliases);
    if (score < 85 && candidate.sourceId !== 'opensubtitles') continue;
    const scored = { ...candidate, score };
    const key = `${candidate.sourceId}:${candidate.episode}:${candidate.language ?? ''}:${candidate.fileHash ?? candidate.url ?? candidate.title}`;
    const previous = unique.get(key);
    if (!previous || scored.score > previous.score) unique.set(key, scored);
  }
  const languageOrder = (candidate: SourceCandidate): number => candidate.language === 'bg' && candidate.kind === 'file' ? 0
    : candidate.language === 'en' ? 1 : candidate.language === 'ja' ? 2 : candidate.kind === 'hardsub' ? 3 : 4;
  return [...unique.values()].sort((a, b) => languageOrder(a) - languageOrder(b) || b.score - a.score);
}

export async function resolveSubtitleSourceDetailed(animeId: number, episode: number): Promise<SubtitleDiscoveryResult> {
  const local = getTitleById(animeId);
  const metadata = await getAniListAnime(animeId).catch(() => null);
  if (!metadata && !local) throw new Error(`AniList has no metadata for ${animeId}`);
  const forms = metadata ? animeTitleForms(metadata) : [local!.english, local!.romaji, local!.native, local!.title_bg].filter((value): value is string => Boolean(value));
  const titles = {
    romaji: metadata?.title.romaji ?? local?.romaji ?? '', english: metadata?.title.english ?? local?.english ?? '',
    native: metadata?.title.native ?? local?.native ?? '', synonyms: metadata?.synonyms ?? [],
  };
  const adapters: SearchAdapter[] = subtitleIndexProviders.map(provider => ({
    id: provider.id,
    isEnabled: () => provider.isEnabled(),
    search: async () => {
      const sourceAliases = subtitleTitleAliases(animeId, provider.id).map(row => row.source_title);
      const queries = [...new Set([...sourceAliases, ...forms])].filter(Boolean).slice(0, 2);
      const found: SourceCandidate[] = [];
      for (const query of queries) {
        const request: SubtitleAnimeIds = {
          animeId: String(animeId), title: query, aliases: [...new Set([...forms, ...titles.synonyms, ...sourceAliases])], episode,
        };
        const rows = await provider.search(request, null, episode);
        found.push(...rows.filter(row => row.episodeNumber === episode).map(row => indexedCandidate(provider, row)));
      }
      return found;
    },
  }));
  // The legacy registry has PlayTube hardsubs and AniMa post resolution; file adapters are supplied by the full index registry above.
  for (const sourceId of ['playtube', 'anima-pr'] as const) {
    const sourceAliases = subtitleTitleAliases(animeId, sourceId).map(row => row.source_title);
    const queries = [...new Set([...sourceAliases, ...forms])].filter(Boolean).slice(0, 2);
    adapters.push({
      id: sourceId,
      isEnabled: () => true,
      search: async () => {
        const found: SourceCandidate[] = [];
        for (const query of queries) {
          const candidates = await subtitleSources[sourceId].searchTitles(query, animeId, episode, titles);
          for (const candidate of candidates) {
            const score = scoreTitleMatch(titles, candidate.title, sourceAliases);
            found.push({ ...candidate, provider: sourceId, providerId: candidate.url || `${sourceId}:${candidate.title}`, score });
          }
        }
        return found;
      },
    });
  }
  const streamAliases = subtitleTitleAliases(animeId, 'provider-captions').map(row => row.source_title);
  const streamQueries = [...new Set([...streamAliases, ...forms])].filter(Boolean).slice(0, 2);
  adapters.push({
    id: 'provider-captions',
    isEnabled: () => true,
    search: async () => {
      const query = streamQueries[0] ?? titles.english ?? titles.romaji ?? titles.native;
      if (!query) return [];
      const candidates = await subtitleSources['provider-captions'].searchTitles(query, animeId, episode, titles, streamAliases);
      return candidates.map(candidate => ({ ...candidate, provider: candidate.sourceId, providerId: `${candidate.sourceId}:${candidate.url}`, score: 100 }));
    },
  });
  const result = await searchAllSubtitleProviders(adapters);
  for (const error of result.errors) console.warn({ provider: error.provider, animeId, episode, stage: 'subtitle-search', reason: error.reason });
  const aliases = [...new Set([...forms, ...titles.synonyms, ...Object.keys(titles).flatMap(key => key === 'synonyms' ? titles.synonyms : [titles[key as 'romaji' | 'english' | 'native']])])];
  return { ...result, candidates: dedupeProviderResults(result, titles, aliases) };
}

export async function resolveSubtitleSource(animeId: number, episode: number): Promise<SourceCandidate[]> {
  return (await resolveSubtitleSourceDetailed(animeId, episode)).candidates;
}

export async function discoverTracks(animeId: number, episodeNumber: number): Promise<SubtitleTrack[]> {
  return (await discoverTracksDetailed(animeId, episodeNumber)).tracks;
}

export async function discoverTracksDetailed(animeId: number, episodeNumber: number): Promise<{ tracks: SubtitleTrack[]; discovery: SubtitleDiscoveryResult }> {
  const discovery = await resolveSubtitleSourceDetailed(animeId, episodeNumber);
  const tracks = discovery.candidates.filter(candidate => candidate.kind === 'file' && (candidate.url || candidate.fetch)).map(candidate => ({
    language: candidate.language ?? 'bg', url: candidate.url, format: candidate.format ?? 'srt', provider: candidate.sourceId,
    headers: {}, attribution: candidate.attribution, fetch: candidate.fetch,
  }));
  return { tracks, discovery };
}

export async function downloadTrack(track: SubtitleTrack): Promise<{ track: SubtitleTrack; text: string }> {
  if (track.fetch) {
    const result = await track.fetch();
    return { track: { ...track, format: result.format, language: result.language }, text: result.body };
  }
  if (!track.url) return { track, text: '' };
  const result = await httpGet(track.url, { provider: track.provider, headers: track.headers, timeoutMs: 30000, retries: 2 });
  if (result.status < 200 || result.status >= 300 || result.text.trim().length < 20) throw new Error(`${track.provider} subtitle returned HTTP ${result.status} or an empty body`);
  const extension = new URL(track.url).pathname.toLowerCase().match(/\.(srt|ass|ssa|vtt)$/)?.[1];
  const contentType = result.headers.get('content-type') ?? '';
  const format = (extension ?? (contentType.includes('subrip') ? 'srt' : contentType.includes('ass') ? 'ass' : contentType.includes('webvtt') ? 'vtt' : track.format)) as SubtitleTrack['format'];
  return { track: { ...track, format }, text: result.text };
}

/** Prefer languages in order while trying every provider copy before moving to the next language. */
export async function firstUsableTrack(tracks: SubtitleTrack[], languages: string[] = ['en', 'ja']): Promise<UsableTrackResult> {
  const failures: TrackAttemptFailure[] = [];
  for (const language of languages) {
    for (const candidate of tracks.filter(track => track.language?.toLowerCase() === language)) {
      try {
        const downloaded = await downloadTrack(candidate);
        const parsed = parseSubtitle(downloaded.text, downloaded.track.format);
        return { track: { ...candidate, language: downloaded.track.language, format: parsed.format, fetch: undefined }, downloaded, parsed, failures };
      } catch (error) {
        failures.push({ provider: candidate.provider, language, reason: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  return { failures };
}
