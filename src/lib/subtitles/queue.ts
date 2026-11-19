import { getEpisodes, getTitles } from '../db';
import { subtitleConfig } from './config';
import { enqueueJobOnce, existingBulgarian, queuePriority } from './storage';

export function shouldRefillSubtitleQueue(depth: number, threshold: number): boolean {
  return Number.isSafeInteger(depth) && depth >= 0 && Number.isSafeInteger(threshold) && threshold > 0 && depth < threshold;
}

export function enqueueEligible(options: { animeIds?: number[]; cap?: number } = {}): { queued: number; eligible: number } {
  const selected = options.animeIds?.length ? new Set(options.animeIds) : undefined;
  const cap = Math.min(subtitleConfig.queueCap, Math.max(1, options.cap ?? subtitleConfig.queueCap));
  const titles = getTitles().filter(title => !selected || selected.has(title.id)).sort((a, b) => queuePriority(b.id) - queuePriority(a.id) || getEpisodes(b.id).length - getEpisodes(a.id).length || a.id - b.id);
  let queued = 0; let eligible = 0;
  for (const title of titles) for (const episode of getEpisodes(title.id)) {
    if (existingBulgarian(title.id, episode.number)) continue;
    eligible++;
    if (queued >= cap) continue;
    const { job, inserted } = enqueueJobOnce(title.id, episode.number);
    if (inserted && job.status !== 'COMPLETED' && job.status !== 'SKIPPED') queued++;
  }
  return { queued, eligible };
}
