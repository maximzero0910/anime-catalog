import { getEpisodes, getTitleById, getTitles } from '../db';
import { ordered, recordFailure, recordSuccess } from '../providers';
import { httpGet, ProviderError, type Provider, type SearchHit } from '../providers/types';
import providerMap from '../../../data/provider-map.json';
import type { SourceLanguage } from './inference';
import { existingBulgarian } from './storage';

interface Mapping { provider: string; episodes: Array<{ number: number; providerEpisodeId: string }> }
export interface SubtitleTrack { language: SourceLanguage | 'bg' | string; url: string; format: 'srt' | 'ass' | 'ssa' | 'vtt'; provider: string; headers: Record<string, string>; }
const mappings = providerMap as Record<string, Mapping>;
function norm(value: string): string { return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim(); }
function matchTitle(title: string, hits: SearchHit[]): SearchHit | undefined {
  const expected = norm(title);
  const names = (hit: SearchHit) => [hit.title, ...(hit.alt ?? [])].map(norm);
  return hits.find(hit => names(hit).includes(expected)) ?? hits.filter(hit => names(hit).some(name => name.includes(expected) || expected.includes(name))).sort((a, b) => Math.abs(norm(a.title).length - expected.length) - Math.abs(norm(b.title).length - expected.length))[0];
}
function trackFormat(url: string, contentType?: string): SubtitleTrack['format'] {
  const path = new URL(url).pathname.toLowerCase();
  const extension = path.split('.').pop();
  if (extension === 'ass' || extension === 'ssa' || extension === 'srt' || extension === 'vtt') return extension;
  if (contentType?.includes('subrip')) return 'srt';
  if (contentType?.includes('ass')) return 'ass';
  if (contentType?.includes('webvtt')) return 'vtt';
  return 'vtt';
}
function declaredPlaylistTracks(manifest: string, manifestUrl: string, provider: string, headers: Record<string, string>): SubtitleTrack[] {
  const tracks: SubtitleTrack[] = [];
  for (const line of manifest.split(/\r?\n/)) {
    if (!line.startsWith('#EXT-X-MEDIA:') || !/TYPE=SUBTITLES/i.test(line)) continue;
    const attributes = new Map<string, string>();
    const re = /([A-Z0-9-]+)=(?:"([^"]*)"|([^,]*))/gi;
    for (const match of line.slice(line.indexOf(':') + 1).matchAll(re)) attributes.set(match[1]!.toUpperCase(), match[2] ?? match[3] ?? '');
    const rawLanguage = (attributes.get('LANGUAGE') ?? attributes.get('NAME') ?? '').toLowerCase().split(/[-_]/)[0]!;
    const language = /^(bg|bul|bulgarian)$/.test(rawLanguage) ? 'bg' : /^(en|eng|english)$/.test(rawLanguage) ? 'en' : /^(ja|jpn|japanese)$/.test(rawLanguage) ? 'ja' : '';
    const uri = attributes.get('URI');
    if (language && uri) tracks.push({ language, url: new URL(uri, manifestUrl).href, format: trackFormat(uri), provider, headers });
  }
  return tracks;
}
export async function findProviderEpisode(animeId: number, episodeNumber: number): Promise<{ provider: Provider; episodeId: string }> {
  const title = getTitleById(animeId);
  if (!title) throw new ProviderError('empty', 'subtitle-discovery', `Anime ${animeId} is absent from the catalog`);
  const mapped = mappings[String(animeId)];
  const providers = ordered();
  if (mapped) providers.sort((a, b) => Number(b.id === mapped.provider) - Number(a.id === mapped.provider));
  for (const provider of providers) {
    try {
      const exact = mapped?.provider === provider.id ? mapped.episodes.find(item => item.number === episodeNumber) : undefined;
      if (exact) return { provider, episodeId: exact.providerEpisodeId };
      const displayTitle = title.english ?? title.romaji ?? title.native ?? title.title_bg ?? title.slug;
      const hit = matchTitle(displayTitle, await provider.searchByTitle(displayTitle));
      if (!hit) { recordFailure(provider.id); continue; }
      const episode = (await provider.listEpisodes(hit.id)).find(item => item.num === episodeNumber);
      if (episode) return { provider, episodeId: episode.id };
      recordFailure(provider.id);
    } catch (error) {
      recordFailure(provider.id);
      console.warn({ provider: provider.id, ep: `${animeId}:${episodeNumber}`, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  throw new ProviderError('empty', 'subtitle-discovery', `No provider episode found for ${animeId}:${episodeNumber}`);
}

export async function discoverTracks(animeId: number, episodeNumber: number): Promise<SubtitleTrack[]> {
  if (existingBulgarian(animeId, episodeNumber)) return [{ language: 'bg', url: '', format: 'vtt', provider: 'local', headers: {} }];
  const { provider, episodeId } = await findProviderEpisode(animeId, episodeNumber);
  const tracks: SubtitleTrack[] = [];
  for (const mode of ['sub', 'dub'] as const) {
    try {
      const sources = await provider.resolve(episodeId, mode);
      for (const source of sources) {
        for (const subtitle of source.subtitles) {
          if (/\/(?:preview|thumbnails?)(?:\/|\.|$)/i.test(new URL(subtitle.url).pathname)) continue;
          const rawLanguage = subtitle.lang.toLowerCase().split(/[-_]/)[0] ?? '';
          const language = /^(bg|bul|bulgarian)$/.test(rawLanguage) ? 'bg' : /^(en|eng|english)$/.test(rawLanguage) ? 'en' : /^(ja|jpn|japanese)$/.test(rawLanguage) ? 'ja' : '';
          if (!language) continue;
          tracks.push({ language, url: subtitle.url, format: subtitle.format, provider: provider.id, headers: source.headers });
        }
        if (source.type === 'hls') {
          try {
            const manifest = await httpGet(source.url, { provider: provider.id, headers: source.headers, timeoutMs: 15000, retries: 0 });
            tracks.push(...declaredPlaylistTracks(manifest.text, manifest.finalUrl || source.url, provider.id, source.headers));
          } catch { /* Providers that expose no readable master playlist can still supply their direct track list. */ }
        }
      }
      if (tracks.length) recordSuccess(provider.id);
    } catch (error) {
      if (error instanceof ProviderError && error.kind === 'blocked') console.warn({ provider: provider.id, ep: `${animeId}:${episodeNumber}`, reason: error.kind });
    }
  }
  const seen = new Set<string>();
  return tracks.filter(track => { const key = `${track.language}:${track.url}`; if (seen.has(key)) return false; seen.add(key); return true; });
}

export async function downloadTrack(track: SubtitleTrack): Promise<{ track: SubtitleTrack; text: string }> {
  if (!track.url) return { track, text: '' };
  const result = await httpGet(track.url, { provider: track.provider, headers: track.headers, timeoutMs: 30000, retries: 2 });
  if (result.status < 200 || result.status >= 300 || result.text.trim().length < 20) throw new ProviderError('empty', track.provider, `Subtitle track returned HTTP ${result.status} or an empty body`);
  const format = trackFormat(track.url, result.headers.get('content-type') ?? undefined);
  return { track: { ...track, format }, text: result.text };
}
export function supportedEpisodeCount(animeId?: number): number {
  return animeId ? getEpisodes(animeId).length : getTitles().reduce((sum, title) => sum + getEpisodes(title.id).length, 0);
}
