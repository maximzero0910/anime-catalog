export interface SubtitleProviderCandidate {
  provider?: string;
  providerId: string;
  episode: number;
  language?: string;
  url?: string | null;
  fileHash?: string | null;
  releaseGroup?: string | null;
  filename?: string | null;
  kind?: string;
  providerAlternates?: SubtitleProviderCandidate[];
}

export interface SubtitleSearchProvider<C extends SubtitleProviderCandidate> {
  id: string;
  isEnabled(): boolean;
  search(): Promise<C[]>;
}

export interface SubtitleProviderSearchError {
  provider: string;
  reason: string;
}

export interface SubtitleProviderSearchResult<C extends SubtitleProviderCandidate> {
  candidates: C[];
  checkedProviders: string[];
  errors: SubtitleProviderSearchError[];
  emptyProviders: string[];
  state: 'not-searched' | 'available' | 'temporary-failure' | 'exhausted';
  primaryProvider: string | null;
  primaryEmpty: boolean;
  exhaustedAllProviders: boolean;
}

function normalizeLanguage(value: string): string {
  const language = value.trim().toLowerCase().split(/[-_]/, 1)[0] ?? '';
  if (['bg', 'bul', 'bulgarian'].includes(language)) return 'bg';
  if (['en', 'eng', 'english'].includes(language)) return 'en';
  if (['ja', 'jpn', 'japanese', 'nihongo'].includes(language)) return 'ja';
  return language;
}

function normalizeRelease(value: string | null | undefined): string {
  return (value ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function duplicateKey(candidate: SubtitleProviderCandidate, providerId: string): string {
  const language = normalizeLanguage(candidate.language ?? '');
  const fileHash = candidate.fileHash?.trim().toLowerCase();
  const kind = candidate.kind ?? 'file';
  if (fileHash) return `${kind}:hash:${candidate.episode}:${language}:${fileHash}`;
  const filename = normalizeRelease(candidate.filename);
  const release = normalizeRelease(candidate.releaseGroup);
  if (filename || release) return `${kind}:release:${candidate.episode}:${language}:${release}:${filename}`;
  const url = candidate.url?.trim();
  if (url) return `${kind}:url:${candidate.episode}:${language}:${url}`;
  return `${kind}:provider:${providerId}:${candidate.episode}:${language}:${candidate.providerId}`;
}

/** Query every enabled provider in configured order; one failure never short-circuits the rest. */
export async function searchAllSubtitleProviders<C extends SubtitleProviderCandidate>(
  providers: SubtitleSearchProvider<C>[],
): Promise<SubtitleProviderSearchResult<C>> {
  const candidates: C[] = [];
  const checkedProviders: string[] = [];
  const errors: SubtitleProviderSearchError[] = [];
  const emptyProviders: string[] = [];
  const seen = new Map<string, number>();

  for (const provider of providers) {
    if (!provider.isEnabled()) continue;
    checkedProviders.push(provider.id);
    try {
      const rows = await provider.search();
      let usable = 0;
      for (const candidate of rows) {
        if (!candidate.url && !candidate.providerId) continue;
        usable++;
        const key = duplicateKey(candidate, provider.id);
        const priorIndex = seen.get(key);
        if (priorIndex !== undefined) {
          const prior = candidates[priorIndex]!;
          if (prior.provider !== candidate.provider) {
            const alternates = [...(prior.providerAlternates ?? []), candidate];
            candidates[priorIndex] = { ...prior, providerAlternates: alternates } as C;
          }
          continue;
        }
        seen.set(key, candidates.length);
        candidates.push(candidate);
      }
      if (!rows.length || !usable) emptyProviders.push(provider.id);
    } catch (error) {
      errors.push({ provider: provider.id, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  const hasPlayableCandidate = candidates.some(candidate => candidate.kind !== 'catalog');
  const state = !checkedProviders.length ? 'not-searched' : errors.length ? 'temporary-failure' : hasPlayableCandidate ? 'available' : 'exhausted';
  const primaryProvider = checkedProviders[0] ?? null;
  const primaryEmpty = primaryProvider !== null && emptyProviders.includes(primaryProvider);
  return { candidates, checkedProviders, errors, emptyProviders, state, primaryProvider, primaryEmpty, exhaustedAllProviders: state === 'exhausted' };
}

export function normalizedSubtitleLanguage(value: string): 'bg' | 'en' | 'ja' | null {
  const language = normalizeLanguage(value);
  return language === 'bg' || language === 'en' || language === 'ja' ? language : null;
}

export function subtitleDiscoveryNeedsRetry(result: Pick<SubtitleProviderSearchResult<SubtitleProviderCandidate>, 'errors'>, unusableFiles = 0): boolean {
  return result.errors.length > 0 || unusableFiles > 0;
}
