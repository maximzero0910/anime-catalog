import { getTitleById } from '../db';
import { httpGet } from '../providers/types';
import { getAniListAnime } from '../anilist';
import { subtitleTitleAliases } from './storage';
import { animeTitleForms, scoreTitleMatch } from './match';
import { subtitleSources, type Candidate } from './sources';
import type { SourceLanguage } from './inference';

export interface SubtitleTrack {
  language: SourceLanguage | 'bg' | string;
  url: string;
  format: 'srt' | 'ass' | 'ssa' | 'vtt';
  provider: string;
  headers: Record<string, string>;
  attribution?: string;
  fetch?: Candidate['fetch'];
}
export interface SourceCandidate extends Candidate { score: number; }

export async function resolveSubtitleSource(animeId: number, episode: number): Promise<SourceCandidate[]> {
  const local = getTitleById(animeId);
  const metadata = await getAniListAnime(animeId).catch(() => null);
  if (!metadata && !local) throw new Error(`AniList has no metadata for ${animeId}`);
  const forms = metadata ? animeTitleForms(metadata) : [local!.english, local!.romaji, local!.native, local!.title_bg].filter((value): value is string => Boolean(value));
  const titles = {
    romaji: metadata?.title.romaji ?? local?.romaji ?? '', english: metadata?.title.english ?? local?.english ?? '',
    native: metadata?.title.native ?? local?.native ?? '', synonyms: metadata?.synonyms ?? [],
  };
  const output: SourceCandidate[] = [];
  // DECISION: Subtitle discovery queries the three subtitle registries only. Video provider imports are intentionally absent.
  for (const sourceId of Object.keys(subtitleSources) as Array<keyof typeof subtitleSources>) {
    const sourceAliases = subtitleTitleAliases(animeId, sourceId).map(row => row.source_title);
    const queries = [...new Set([...sourceAliases, ...forms])].filter(Boolean).slice(0, 2);
    for (const query of queries) {
      try {
        const candidates = await subtitleSources[sourceId].searchTitles(query, animeId, episode, titles);
        for (const candidate of candidates) {
          const score = scoreTitleMatch(titles, candidate.title, sourceAliases);
          output.push({ ...candidate, score });
        }
      } catch (error) {
        console.warn({ source: sourceId, animeId, episode, stage: 'subtitle-search', reason: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  const unique = new Map<string, SourceCandidate>();
  for (const candidate of output) {
    const key = `${candidate.sourceId}:${candidate.episode}:${candidate.url}`;
    const old = unique.get(key);
    if (!old || candidate.score > old.score) unique.set(key, candidate);
  }
  const order = (candidate: SourceCandidate) => candidate.kind === 'file' && candidate.language === 'bg' ? 0 : candidate.kind === 'file' ? 1 : candidate.kind === 'hardsub' ? 2 : 3;
  return [...unique.values()].sort((a, b) => order(a) - order(b) || b.score - a.score);
}

export async function discoverTracks(animeId: number, episodeNumber: number): Promise<SubtitleTrack[]> {
  const candidates = await resolveSubtitleSource(animeId, episodeNumber);
  return candidates.filter(candidate => candidate.kind === 'file' && candidate.url).map(candidate => ({
    language: candidate.language ?? 'bg', url: candidate.url, format: candidate.format ?? 'srt', provider: candidate.sourceId,
    headers: {}, attribution: candidate.attribution, fetch: candidate.fetch,
  }));
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
