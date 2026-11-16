import { parseSubtitle, formatTime } from './normalize';
import { addSubtitleTitleAliases, enqueueSubtitleIndexJob, readSubtitleAsset, resolveIndexedSubtitle, storeSubtitleAsset, upsertSubtitleIndex } from './storage';
import type { SubtitleAnimeIds, SubtitleCandidate, SubtitleIndexProvider } from './index-providers';

export interface IndexedSubtitleTrack { body: string; format: string; sourceUrl: string; attribution: string; language: string; qualityScore: number; verified: boolean; machineTranslated: boolean; needsFetch: false; }

// DECISION: only exact hash, exact release-group, or timing-checked matches can auto-attach; weaker matches remain indexed for review.
export function subtitleMatchScore(candidate: Pick<SubtitleCandidate, 'fileHash' | 'releaseGroup' | 'durationMs' | 'catalogOnly'>, request: Pick<SubtitleAnimeIds, 'fileHash' | 'releaseGroup' | 'durationMs'>, finalCueMs?: number): { score: number; verified: boolean } {
  if (candidate.catalogOnly) return { score: 0.3, verified: false };
  if (request.durationMs && finalCueMs != null && Math.abs(finalCueMs - request.durationMs) > 2000) return { score: 0, verified: false };
  if (request.fileHash && candidate.fileHash && request.fileHash.toLowerCase() === candidate.fileHash.toLowerCase()) return { score: 1, verified: true };
  if (request.releaseGroup && candidate.releaseGroup && request.releaseGroup.trim().toLowerCase() === candidate.releaseGroup.trim().toLowerCase()) return { score: 0.85, verified: true };
  if (request.durationMs && candidate.durationMs && Math.abs(request.durationMs - candidate.durationMs) <= 1000 && finalCueMs != null && Math.abs(finalCueMs - request.durationMs) <= 2000) return { score: 0.7, verified: true };
  return { score: 0, verified: false };
}

export function subtitleToVtt(body: string, format: string): string {
  if (format.toLowerCase() === 'vtt') return body.startsWith('WEBVTT') ? body : `WEBVTT\n\n${body}`;
  const parsed = parseSubtitle(body, format as 'srt' | 'ass' | 'ssa');
  const cues = parsed.cues.map(cue => {
    let text = cue.originalText;
    if (format === 'ass' || format === 'ssa') text = text.replace(/\\N/g, '\n').replace(/\\n/g, '\n').replace(/\\h/g, ' ').replace(/\{\\i1\}/gi, '<i>').replace(/\{\\i0\}/gi, '</i>').replace(/\{\\b1\}/gi, '<b>').replace(/\{\\b0\}/gi, '</b>').replace(/\{[^}]*\}/g, '');
    return `${cue.id}\n${formatTime(cue.start)} --> ${formatTime(cue.end)}\n${text}`;
  });
  return `WEBVTT\n\n${cues.join('\n\n')}\n`;
}

export function registerAnimeAliases(animeId: string, names: string[]): void { addSubtitleTitleAliases(animeId, names.filter(Boolean)); }

export async function resolveIndexedBgSubtitle(animeId: string, episode: number, title: string, durationMs?: number | null): Promise<{ track?: IndexedSubtitleTrack; catalog?: { sourceUrl: string; attribution: string }; queued: boolean }> {
  const rows = resolveIndexedSubtitle(animeId, episode, 'bg', title);
  let catalog: { sourceUrl: string; attribution: string } | undefined;
  for (const row of rows) {
    if (Number(row.catalog_only)) {
      if (!catalog && row.source_url) catalog = { sourceUrl: String(row.source_url), attribution: String(row.attribution ?? 'AniMa BG Fansubs') };
      continue;
    }
    const manuallyVerified = row.verification_state === 'VERIFIED';
    if ((Number(row.quality_score) < 0.85 && !manuallyVerified) || !Number(row.verified) || !row.asset_hash) continue;
    if (durationMs && row.duration_ms && Math.abs(Number(row.duration_ms) - durationMs) > 2000) continue;
    const asset = await readSubtitleAsset(String(row.asset_hash));
    if (!asset) continue;
    return { track: { body: subtitleToVtt(asset.body, String(row.asset_format ?? row.format ?? asset.asset.format)), format: 'vtt', sourceUrl: String(row.source_url ?? ''), attribution: String(row.attribution ?? row.provider), language: 'bg', qualityScore: Number(row.quality_score), verified: true, machineTranslated: row.provider === 'local-validated-translation', needsFetch: false }, queued: false };
  }
  return { ...(catalog ? { catalog } : {}), queued: enqueueSubtitleIndexJob({ animeId, episode, durationMs: durationMs ?? null }) };
}

export async function indexSubtitleCandidate(provider: SubtitleIndexProvider, request: SubtitleAnimeIds, candidate: SubtitleCandidate): Promise<void> {
  let score = subtitleMatchScore(candidate, request);
  let assetHash: string | null = null;
  if (candidate.language === 'bg' && candidate.fetchable && !candidate.catalogOnly) {
    const file = await provider.fetch(candidate);
    const parsed = parseSubtitle(file.body, file.format);
    const finalCue = parsed.cues.at(-1);
    const cueEnd = finalCue?.end;
    const cueMs = cueEnd == null ? undefined : cueEnd * 1000;
    score = subtitleMatchScore(candidate, request, cueMs);
    if (parsed.cues.length > 0) {
      const stored = await storeSubtitleAsset(file.body, file.format, 'bg', { provider: candidate.provider, providerId: candidate.providerId, sourceUrl: candidate.sourceUrl, attribution: candidate.attribution });
      assetHash = stored.hash;
    }
  }
  upsertSubtitleIndex({ ...candidate, qualityScore: candidate.catalogOnly ? 0.3 : score.score, verified: score.verified, assetHash });
}
