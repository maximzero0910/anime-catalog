import type { Provider, SearchHit } from './types';
import { withResourceLimit } from '../resource-limits';

export interface AggregatedSearchHit extends SearchHit { providerId: string; }
export interface ProviderSearchStatus { providerId: string; count: number; error?: string; }
export interface AggregatedProviderSearch {
  results: AggregatedSearchHit[];
  providers: ProviderSearchStatus[];
}

type SearchableProvider = Pick<Provider, 'id' | 'searchByTitle'>;
type SearchFunction = (provider: SearchableProvider, query: string) => Promise<SearchHit[]>;

export async function searchAcrossProviders(
  query: string,
  providers: SearchableProvider[],
  timeoutMs = 9_000,
  search: SearchFunction = (provider, value) => provider.searchByTitle(value),
): Promise<AggregatedProviderSearch> {
  const attempts = await Promise.all(providers.map(async provider => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const hits = await Promise.race([
        withResourceLimit('provider-search', () => search(provider, query)),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('search timed out')), timeoutMs); }),
      ]);
      const unique = new Map<string, SearchHit>();
      for (const hit of hits.slice(0, 50)) if (hit.id && hit.title && !unique.has(hit.id)) unique.set(hit.id, hit);
      return {
        results: [...unique.values()].map(hit => ({ ...hit, providerId: provider.id })),
        status: { providerId: provider.id, count: unique.size } satisfies ProviderSearchStatus,
      };
    } catch (error) {
      return {
        results: [] as AggregatedSearchHit[],
        status: { providerId: provider.id, count: 0, error: error instanceof Error ? error.message : String(error) } satisfies ProviderSearchStatus,
      };
    } finally { if (timer) clearTimeout(timer); }
  }));
  return { results: attempts.flatMap(result => result.results), providers: attempts.map(result => result.status) };
}
