import type { AudioMode, Provider, SearchHit, StreamSource } from './types';

const normalizeTitle = (value: string) => value.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');

function withTimeout<T>(promise: Promise<T>, milliseconds = 10_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('provider fallback timed out')), milliseconds);
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

export function isExactProviderTitle(hit: SearchHit, title: string): boolean {
  const wanted = normalizeTitle(title);
  return Boolean(wanted) && [hit.title, ...(hit.alt ?? [])].some(candidate => normalizeTitle(candidate) === wanted);
}

export async function resolveExactTitleFallback(
  title: string,
  episodeNumber: number,
  candidates: Provider[],
  excludedProvider: string,
  mode: AudioMode,
  isPlayable: (source: StreamSource) => Promise<boolean>,
): Promise<StreamSource | undefined> {
  if (!title.trim() || !Number.isSafeInteger(episodeNumber) || episodeNumber < 1) return undefined;
  const providers = candidates.filter(provider => provider.id !== excludedProvider).slice(0, 3);
  const attempts = providers.map(provider => withTimeout((async () => {
    const hits = await provider.searchByTitle(title);
    const exact = hits.find(hit => isExactProviderTitle(hit, title));
    if (!exact) throw new Error('exact title not found');
    const episode = (await provider.listEpisodes(exact.id)).find(item => item.num === episodeNumber);
    if (!episode) throw new Error('episode not found');
    for (const source of await provider.resolve(episode.id, mode)) {
      if (await isPlayable(source)) return source;
    }
    throw new Error('no playable source');
  })()));
  try { return await Promise.any(attempts); } catch { return undefined; }
}
