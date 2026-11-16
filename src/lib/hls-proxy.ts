import { lookup } from 'node:dns/promises';
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
type ResolvedAddress = { address: string; family: number };
type Resolver = (host: string, options: { all: true; verbatim: true }) => Promise<ResolvedAddress[]>;
let active = 0;
let waiting = 0;

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
}

function publicAddress(value: string): boolean {
  try {
    let address = ipaddr.parse(value);
    if (address.kind() === 'ipv6') address = (address as ipaddr.IPv6).toIPv4Address?.() ?? address;
    return address.range() === 'unicast';
  } catch { return false; }
}

export async function validateDestination(url: URL, rules: string[], resolve: Resolver = lookup as Resolver): Promise<string[]> {
  if (url.protocol !== 'https:') throw new ProxyError(400, 'https-required');
  if (url.username || url.password || !url.hostname || !providerHostAllowed(url.hostname, rules)) throw new ProxyError(403, 'host-not-allowed');
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

async function acquire(signal: AbortSignal, maxActive = MAX_ACTIVE, maxWaiting = MAX_WAITING): Promise<() => void> {
  if (signal.aborted) throw new ProxyError(499, 'client-cancelled');
  if (active >= maxActive && waiting >= maxWaiting) throw new ProxyError(503, 'proxy-overloaded');
  if (active < maxActive) { active++; return () => { active--; }; }
  waiting++;
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setInterval(() => {
        if (signal.aborted) { clearInterval(timer); reject(signal.reason); }
        else if (active < MAX_ACTIVE) { clearInterval(timer); waiting--; active++; resolve(); }
      }, 20);
      signal.addEventListener('abort', () => { clearInterval(timer); waiting = Math.max(0, waiting - 1); reject(signal.reason); }, { once: true });
    });
  } catch (error) { if (signal.aborted) throw new ProxyError(499, 'client-cancelled'); throw new ProxyError(503, 'proxy-overloaded'); }
  return () => { active--; };
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
      const addresses = await validateDestination(current, rules, runtime.resolve);
      const pinned = addresses[0]!;
      const dispatcher = new Agent({ connect: { lookup: (_hostname, _options, callback) => callback(null, pinned, ipaddr.parse(pinned).kind() === 'ipv4' ? 4 : 6) } });
      let response: Response;
      try {
        const requestInit = {
          ...init, signal, redirect: 'manual', dispatcher,
          headers: { ...Object.fromEntries(new Headers(init.headers).entries()), host: current.host },
        };
        response = runtime.fetcher
          ? await runtime.fetcher(current, requestInit)
          : await undiciFetch(current, requestInit as Parameters<typeof undiciFetch>[1]) as unknown as Response;
      } finally { await dispatcher.close(); }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location || hop === MAX_REDIRECTS) throw new ProxyError(502, 'redirect-limit');
        current = new URL(location, current);
        continue;
      }
      const declaredManifest = (response.headers.get('content-type') ?? '').toLowerCase().includes('mpegurl') || current.pathname.toLowerCase().endsWith('.m3u8');
      const body = await boundedBody(response, declaredManifest ? MAX_MANIFEST_BYTES : MAX_MEDIA_BYTES);
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
