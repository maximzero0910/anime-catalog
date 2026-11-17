import { lookup } from 'node:dns/promises';
import { createHash, randomBytes } from 'node:crypto';
import { Agent, fetch as undiciFetch } from 'undici';
import ipaddr from 'ipaddr.js';
import { providerHostAllowed } from './provider-host-policy';

const MAX_REDIRECTS = 3;
const MAX_MANIFEST_BYTES = 1_048_576;
const MAX_MEDIA_BYTES = 32 * 1_048_576;
const REQUEST_TIMEOUT_MS = 12_000;
const TOTAL_TIMEOUT_MS = 25_000;
const MAX_ACTIVE = 8;
const MAX_WAITING = 16;
const MAX_PROXY_TOKENS = 50_000;
const PROXY_TOKEN_TTL_MS = 2 * 60 * 60_000;
const PROXY_TOKEN_PRUNE_INTERVAL_MS = 30_000;
type ResolvedAddress = { address: string; family: number };
type Resolver = (host: string, options: { all: true; verbatim: true }) => Promise<ResolvedAddress[]>;
let active = 0;
let waiting = 0;
type ProxyWaiter = { signal: AbortSignal; maxActive: number; resolve: (release: () => void) => void; reject: (error: unknown) => void; onAbort: () => void };
const proxyWaiters: ProxyWaiter[] = [];
const proxyTargets = new Map<string, { url: string; referer: string; expiresAt: number; key: string }>();
const proxyTokensByTarget = new Map<string, string>();
let proxyTargetsLastPruned = 0;

export class ProxyError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export interface ProxyRuntime {
  resolve?: Resolver;
  fetcher?: (url: URL, init: Record<string, unknown>) => Promise<Response>;
  requestTimeoutMs?: number;
  totalTimeoutMs?: number;
  maxActive?: number;
  maxWaiting?: number;
  manifestAuthorizedTarget?: boolean;
  /** Permit HTTP only for these exact legacy provider hosts. */
  allowHttpHosts?: string[];
  /** Override the bounded body size for non-manifest provider responses. */
  maxResponseBytes?: number;
}

function publicAddress(value: string): boolean {
  try {
    let address = ipaddr.parse(value);
    if (address.kind() === 'ipv6' && (address as ipaddr.IPv6).isIPv4MappedAddress()) {
      address = (address as ipaddr.IPv6).toIPv4Address();
    }
    return address.range() === 'unicast';
  } catch { return false; }
}

export async function validateDestination(url: URL, rules: string[], resolve: Resolver = lookup as Resolver, manifestAuthorizedTarget = false, allowHttpHosts: string[] = []): Promise<string[]> {
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && allowHttpHosts.includes(hostname))) throw new ProxyError(400, 'https-required');
  if (url.username || url.password || !url.hostname || (!manifestAuthorizedTarget && !providerHostAllowed(hostname, rules))) throw new ProxyError(403, 'host-not-allowed');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = ipaddr.isValid(host)
      ? [{ address: host, family: ipaddr.parse(host).kind() === 'ipv4' ? 4 : 6 }]
      : await resolve(host, { all: true, verbatim: true });
  } catch { throw new ProxyError(502, 'dns-resolution-failed'); }
  if (!addresses.length || addresses.some(item => !publicAddress(item.address))) throw new ProxyError(403, 'non-public-destination');
  return addresses.map(item => item.address);
}

function pruneProxyTargets(now = Date.now()): void {
  if (now - proxyTargetsLastPruned < PROXY_TOKEN_PRUNE_INTERVAL_MS) return;
  proxyTargetsLastPruned = now;
  for (const [token, target] of proxyTargets) {
    if (target.expiresAt > now) continue;
    proxyTargets.delete(token);
    proxyTokensByTarget.delete(target.key);
  }
}

/** Mint a bounded, expiring capability for a server-selected provider resource. */
export function issueManifestProxyToken(url: string, referer: string): string {
  const targetUrl = new URL(url);
  if (targetUrl.protocol !== 'https:' || targetUrl.username || targetUrl.password || !targetUrl.hostname) throw new ProxyError(400, 'invalid-manifest-target');
  if (referer) {
    const ref = new URL(referer);
    if (ref.protocol !== 'https:' || ref.username || ref.password) throw new ProxyError(400, 'invalid-referer');
  }
  const key = createHash('sha256').update(`${targetUrl.href}\n${referer}`).digest('hex');
  const now = Date.now();
  pruneProxyTargets(now);
  const existing = proxyTokensByTarget.get(key);
  if (existing) {
    const target = proxyTargets.get(existing);
    if (target) { target.expiresAt = now + PROXY_TOKEN_TTL_MS; return existing; }
  }
  if (proxyTargets.size >= MAX_PROXY_TOKENS) {
    const oldest = proxyTargets.keys().next().value as string | undefined;
    if (oldest) {
      const target = proxyTargets.get(oldest);
      proxyTargets.delete(oldest);
      if (target) proxyTokensByTarget.delete(target.key);
    }
  }
  const token = randomBytes(24).toString('base64url');
  proxyTargets.set(token, { url: targetUrl.href, referer, expiresAt: now + PROXY_TOKEN_TTL_MS, key });
  proxyTokensByTarget.set(key, token);
  return token;
}

export function proxySubtitleTracks<T extends { url: string }>(tracks: T[], referer: string): T[] {
  return tracks.flatMap(track => {
    try {
      const url = new URL(track.url);
      if (url.protocol !== 'https:' || url.username || url.password) return [];
      const token = issueManifestProxyToken(url.href, referer);
      return [{ ...track, url: `/api/hls?t=${encodeURIComponent(token)}` }];
    } catch {
      return [];
    }
  });
}

export function resolveManifestProxyToken(token: string): { url: string; referer: string } | undefined {
  const target = proxyTargets.get(token);
  if (!target) return undefined;
  if (target.expiresAt <= Date.now()) {
    proxyTargets.delete(token);
    proxyTokensByTarget.delete(target.key);
    return undefined;
  }
  return { url: target.url, referer: target.referer };
}

function releaseActive(): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    active = Math.max(0, active - 1);
    for (let index = 0; index < proxyWaiters.length; index++) {
      const waiter = proxyWaiters[index]!;
      if (waiter.signal.aborted) {
        proxyWaiters.splice(index--, 1);
        waiting = Math.max(0, waiting - 1);
        waiter.signal.removeEventListener('abort', waiter.onAbort);
        waiter.reject(new ProxyError(499, 'client-cancelled'));
        continue;
      }
      if (active >= waiter.maxActive) continue;
      proxyWaiters.splice(index, 1);
      waiting = Math.max(0, waiting - 1);
      waiter.signal.removeEventListener('abort', waiter.onAbort);
      active++;
      waiter.resolve(releaseActive());
      break;
    }
  };
}

async function acquire(signal: AbortSignal, maxActive = MAX_ACTIVE, maxWaiting = MAX_WAITING): Promise<() => void> {
  if (signal.aborted) throw new ProxyError(499, 'client-cancelled');
  if (active >= maxActive && waiting >= maxWaiting) throw new ProxyError(503, 'proxy-overloaded');
  if (active < maxActive && waiting === 0) { active++; return releaseActive(); }
  waiting++;
  return new Promise<() => void>((resolve, reject) => {
    const waiter: ProxyWaiter = {
      signal, maxActive, resolve, reject,
      onAbort: () => {
        const index = proxyWaiters.indexOf(waiter);
        if (index < 0) return;
        proxyWaiters.splice(index, 1);
        waiting = Math.max(0, waiting - 1);
        reject(new ProxyError(499, 'client-cancelled'));
      },
    };
    proxyWaiters.push(waiter);
    signal.addEventListener('abort', waiter.onAbort, { once: true });
    if (signal.aborted) waiter.onAbort();
  });
}

async function boundedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > maxBytes) throw new ProxyError(413, 'upstream-response-too-large');
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new ProxyError(413, 'upstream-response-too-large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const output = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return output;
}

export async function fetchPublic(url: URL, init: RequestInit, rules: string[], clientSignal: AbortSignal, runtime: ProxyRuntime = {}): Promise<Response> {
  const release = await acquire(clientSignal, runtime.maxActive, runtime.maxWaiting);
  const total = AbortSignal.timeout(runtime.totalTimeoutMs ?? TOTAL_TIMEOUT_MS);
  let current = url;
  let timedOut = false;
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const hopTimeout = AbortSignal.timeout(runtime.requestTimeoutMs ?? REQUEST_TIMEOUT_MS);
      const signal = AbortSignal.any([clientSignal, total, hopTimeout]);
      signal.addEventListener('abort', () => { if (!clientSignal.aborted) timedOut = true; }, { once: true });
      const addresses = await validateDestination(current, rules, runtime.resolve, runtime.manifestAuthorizedTarget, runtime.allowHttpHosts);
      const pinned = addresses.find(item => !item.includes(':')) ?? addresses[0]!;
      const family = ipaddr.parse(pinned).kind() === 'ipv4' ? 4 : 6;
      const dispatcher = new Agent({ connect: { lookup: (_hostname, options, callback) => {
        if (options.all) callback(null, [{ address: pinned, family }]);
        else callback(null, pinned, family);
      } } });
      let response: Response;
      try {
        const requestInit = {
          ...init, signal, redirect: 'manual', dispatcher,
          headers: { ...Object.fromEntries(new Headers(init.headers).entries()), host: current.host },
        };
        response = runtime.fetcher
          ? await runtime.fetcher(current, requestInit)
          : await undiciFetch(current, requestInit as Parameters<typeof undiciFetch>[1]) as unknown as Response;
      } catch (error) {
        await dispatcher.close();
        throw error;
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        await dispatcher.close();
        if (!location || hop === MAX_REDIRECTS) throw new ProxyError(502, 'redirect-limit');
        current = new URL(location, current);
        continue;
      }
      const declaredManifest = (response.headers.get('content-type') ?? '').toLowerCase().includes('mpegurl') || current.pathname.toLowerCase().endsWith('.m3u8');
      let body: Uint8Array;
      try {
        body = await boundedBody(response, declaredManifest ? MAX_MANIFEST_BYTES : runtime.maxResponseBytes ?? MAX_MEDIA_BYTES);
      } finally { await dispatcher.close(); }
      const headers = new Headers(response.headers);
      headers.delete('set-cookie'); headers.delete('set-cookie2');
      if (declaredManifest && response.ok) {
        const text = new TextDecoder().decode(body);
        if (body.byteLength <= 40 || !text.slice(0, 512).includes('#EXTM3U')) throw new ProxyError(502, 'invalid-manifest');
        return new Response(text, { status: response.status, headers });
      }
      return new Response(body as unknown as BodyInit, { status: response.status, headers });
    }
    throw new ProxyError(502, 'redirect-limit');
  } catch (error) {
    if (error instanceof ProxyError) throw error;
    throw new ProxyError(clientSignal.aborted ? 499 : timedOut ? 504 : 502, clientSignal.aborted ? 'client-cancelled' : timedOut ? 'upstream-timeout' : 'upstream-failed');
  } finally { release(); }
}

export function proxyLimits(): { active: number; waiting: number } { return { active, waiting }; }
