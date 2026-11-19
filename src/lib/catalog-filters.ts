export interface CatalogFilters {
  genres?: string[];
  types?: string[];
  year?: number | null;
  yearFrom?: number | null;
  yearTo?: number | null;
  recent?: boolean;
  season?: string;
  status?: string;
  format?: string;
  minRating?: number;
  sort?: string;
}

export interface FilterableAnime {
  id: string;
  title: string | { english?: string; romaji?: string; native?: string };
  image?: string;
  cover?: string;
  releaseDate?: string;
  type?: string;
  alt?: string[];
  genres?: string[];
  tags?: string[];
  year?: number;
  releaseTimestamp?: number;
  season?: string;
  status?: string;
  rating?: number;
  popularity?: number;
  animeType?: string;
  format?: string;
  anilistId?: number;
  providerId?: string;
  providerChoices?: Array<{ providerId: string; id: string }>;
}

function titleOf(item: FilterableAnime): string {
  return typeof item.title === 'string' ? item.title : item.title.english ?? item.title.romaji ?? item.title.native ?? '';
}

const providerPreference: Record<string, number> = { anikoto: 0, '9anime': 1, telegram: 2, playtube: 3, reanime: 4, allanime: 5 };
const normalizeTitle = (value: string) => value.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');

/** Keep one result card per AniList title while retaining each provider's own series ID. */
export function mergeProviderResults<T extends FilterableAnime>(items: T[]): T[] {
  const merged = new Map<string, T>();
  for (const item of items) {
    const key = item.anilistId ? `anilist:${item.anilistId}` : `title:${normalizeTitle(titleOf(item))}`;
    const current = merged.get(key);
    const providerId = item.providerId ?? 'anikoto';
    const choice = { providerId, id: item.id };
    if (!current) {
      merged.set(key, { ...item, providerChoices: [choice] });
      continue;
    }
    const choices = [...(current.providerChoices ?? [{ providerId: current.providerId ?? 'anikoto', id: current.id }]), choice];
    const uniqueChoices = [...new Map(choices.map(source => [source.providerId, source])).values()];
    const currentRank = providerPreference[current.providerId ?? 'anikoto'] ?? 99;
    const nextRank = providerPreference[providerId] ?? 99;
    const preferred = nextRank < currentRank ? item : current;
    merged.set(key, {
      ...current,
      ...preferred,
      image: preferred.image ?? current.image ?? item.image,
      providerChoices: uniqueChoices,
    });
  }
  return [...merged.values()];
}

function hasFormat(item: FilterableAnime, format: string): boolean {
  const type = (item.animeType ?? item.type ?? item.format ?? '').toUpperCase();
  if (format === 'SERIES') return ['TV', 'ONA'].includes(type);
  if (format === 'MOVIE') return type === 'MOVIE';
  if (format === 'SHORT') return type === 'TV_SHORT';
  if (format === 'SPECIAL') return ['SPECIAL', 'OVA', 'MUSIC'].includes(type);
  return true;
}

export function filterAndSortAnime<T extends FilterableAnime>(items: T[], filters: CatalogFilters): T[] {
  const selectedGenres = filters.genres ?? [];
  const selectedTypes = (filters.types ?? []).map(value => value.toUpperCase());
  const nowYear = new Date().getFullYear();
  const filtered = items.filter(item => {
    if (selectedGenres.length && !selectedGenres.some(genre =>
      (item.genres ?? []).some(value => value.toLowerCase() === genre.toLowerCase()) ||
      (item.tags ?? []).some(value => value.toLowerCase() === genre.toLowerCase()))) return false;
    if (selectedTypes.length && !selectedTypes.includes((item.animeType ?? item.type ?? '').toUpperCase())) return false;
    if (filters.year && item.year !== filters.year) return false;
    if (filters.yearFrom && (!item.year || item.year < filters.yearFrom)) return false;
    if (filters.yearTo && (!item.year || item.year > filters.yearTo)) return false;
    if (filters.recent && item.status !== 'RELEASING' && (!item.year || item.year < nowYear - 2)) return false;
    if (filters.season && item.season !== filters.season) return false;
    if (filters.status && item.status !== filters.status) return false;
    if (filters.format && !hasFormat(item, filters.format)) return false;
    if (filters.minRating && (item.rating == null || item.rating < filters.minRating)) return false;
    return true;
  });

  const sorted = [...filtered];
  switch (filters.sort) {
    case 'rating': sorted.sort((a, b) => (b.rating ?? -1) - (a.rating ?? -1)); break;
    case 'recent': sorted.sort((a, b) => (b.releaseTimestamp ?? b.year ?? -1) - (a.releaseTimestamp ?? a.year ?? -1)); break;
    case 'alphabetical': sorted.sort((a, b) => titleOf(a).localeCompare(titleOf(b))); break;
    case 'added': sorted.sort((a, b) => ((b.anilistId ?? Number(b.id)) || 0) - ((a.anilistId ?? Number(a.id)) || 0)); break;
    default: sorted.sort((a, b) => (b.popularity ?? -1) - (a.popularity ?? -1));
  }
  return sorted;
}
