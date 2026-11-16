import type { EpisodeRef, Provider, SearchHit } from './types';
import { scoreTitleMatch, type MatchTitleSet } from '../subtitles/match';

export async function resolveProviderEpisode(provider: Provider, queries: string[], titleSet: MatchTitleSet, aliases: string[], episodeNumber: number): Promise<{ hit: SearchHit; episode: EpisodeRef }> {
  for (const query of [...new Set(queries.map(value => value.trim()).filter(Boolean))]) {
    const hits = await provider.searchByTitle(query);
    const hit = hits.map(candidate => ({ candidate, score: Math.max(scoreTitleMatch(titleSet, candidate.title, aliases), ...(candidate.alt ?? []).map(name => scoreTitleMatch(titleSet, name, aliases))) }))
      .filter(item => item.score >= 85).sort((a, b) => b.score - a.score)[0]?.candidate;
    if (!hit) continue;
    const episode = (await provider.listEpisodes(hit.id)).find(candidate => candidate.num === episodeNumber);
    if (episode) return { hit, episode };
  }
  throw new Error(`${provider.id}: no matched provider title/episode`);
}
