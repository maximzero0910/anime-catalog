import { ProviderError, type AudioMode, type Provider, type SearchHit, type StreamSource, verifyPlaylist } from './types';
import nineanime from './nineanime';
import reanime from './reanime';
import allanime from './allanime';
import anikoto from './anikoto';
import telegram from './telegram';

const providers = new Map<string, Provider>();
const failures = new Map<string, number[]>();
const openedUntil = new Map<string, number>();

export function register(provider: Provider): void { providers.set(provider.id, provider); }
export function getProvider(id: string): Provider | undefined { return providers.get(id); }

// Provider allowlist and priority order. 9anime.or.at is the primary source.
register(nineanime);
register(reanime);
register(allanime);
register(anikoto);
register(telegram);

export function isOpen(id: string): boolean {
  const until = openedUntil.get(id) ?? 0;
  if (until > Date.now()) return true;
  if (until) { openedUntil.delete(id); failures.delete(id); }
  return false;
}

export function recordSuccess(id: string): void { failures.delete(id); openedUntil.delete(id); }

export function recordFailure(id: string): void {
  const cutoff = Date.now() - 10 * 60_000;
  const recent = (failures.get(id) ?? []).filter(time => time >= cutoff);
  recent.push(Date.now());
  failures.set(id, recent);
  if (recent.length >= 5) openedUntil.set(id, Date.now() + 15 * 60_000);
}

export function ordered(): Provider[] {
  return [...providers.values()].filter(provider => !isOpen(provider.id)).sort((a, b) => b.weight * b.score - a.weight * a.score);
}

function withTimeout<T>(promise: Promise<T>, ms: number, provider: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new ProviderError('timeout', provider)), ms);
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

export async function resolveWithFallback(
  hit: SearchHit,
  ep: number | string,
  mode: AudioMode,
  matchFn: (provider: Provider, hit: SearchHit) => boolean = (provider, result) => result.id.startsWith(`${provider.id}:`),
): Promise<StreamSource> {
  const candidates = ordered().filter(provider => matchFn(provider, hit)).slice(0, 2);
  const attempts = candidates.map(async provider => {
    try {
      const sources = await withTimeout(provider.resolve(String(ep), mode), 9000, provider.id);
      for (const source of sources) {
        if (!await verifyPlaylist(source.url, source.headers)) continue;
        provider.score = Math.min(1, provider.score * 1.05);
        recordSuccess(provider.id);
        return source;
      }
      throw new ProviderError('empty', provider.id);
    } catch (error) {
      provider.score = Math.max(0, provider.score * 0.85);
      recordFailure(provider.id);
      console.error({ provider: provider.id, ep, reason: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  });
  try {
    return await Promise.any(attempts);
  } catch {
    throw new ProviderError('empty', 'registry', 'No provider produced a verified stream');
  }
}
