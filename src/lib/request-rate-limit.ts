import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import ipaddr from 'ipaddr.js';

export type RateLimitClass = 'general' | 'search' | 'metadata' | 'resolve' | 'hls' | 'admin';
export type RateBucketClass = 'global' | RateLimitClass;
export interface RatePolicy { perMinute: number; burst: number }
export interface RateLimitResult { allowed: boolean; retryAfterSeconds: number; remaining: number; bucket: RateBucketClass }
export interface RateLimitOptions {
  trustedProxyCidrs?: string[];
  proxySigningSecret?: string;
  policies?: Partial<Record<RateLimitClass, RatePolicy>>;
  globalPolicy?: RatePolicy;
  maxClients?: number;
  idleMs?: number;
  now?: () => number;
}
interface BucketState { tokens: number; updatedAt: number; touchedAt: number }

const DEFAULT_POLICIES: Record<RateLimitClass, RatePolicy> = {
  general: { perMinute: 240, burst: 40 },
  search: { perMinute: 30, burst: 10 },
  metadata: { perMinute: 60, burst: 12 },
  resolve: { perMinute: 18, burst: 6 },
  hls: { perMinute: 900, burst: 90 },
  admin: { perMinute: 30, burst: 6 },
};

function parseAddress(value: string | undefined): ipaddr.IPv4 | ipaddr.IPv6 | undefined {
  if (!value || value.includes(',') || value.length > 64) return undefined;
  try { return ipaddr.process(value.trim()); } catch { return undefined; }
}

function parseTrustedRanges(values: string[]): Array<[ipaddr.IPv4 | ipaddr.IPv6, number]> {
  const ranges: Array<[ipaddr.IPv4 | ipaddr.IPv6, number]> = [];
  for (const value of values) {
    if (!value || value === '*' || value.length > 128) continue;
    try {
      const [address, prefix] = ipaddr.parseCIDR(value.trim());
      ranges.push([address, prefix]);
    } catch { /* Invalid proxy entries are ignored; no wildcard or hostname trust. */ }
  }
  return ranges;
}

export interface SignedProxyIdentity { ip?: string | null; timestamp?: string | null; signature?: string | null }

function verifiedProxyAddress(peerValue: string | undefined, identity: SignedProxyIdentity | undefined, secret: string | undefined, trustedRanges: Array<[ipaddr.IPv4 | ipaddr.IPv6, number]>, now: number): string | undefined {
  if (!secret || Buffer.byteLength(secret) < 32 || !identity?.ip || !identity.timestamp || !identity.signature) return undefined;
  const peer = parseAddress(peerValue);
  const client = parseAddress(identity.ip);
  const timestamp = Number(identity.timestamp);
  if (!peer || !client || !Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > 60_000) return undefined;
  if (!/^\d{13}$/.test(identity.timestamp) || !/^[A-Za-z0-9_-]{43}$/.test(identity.signature)) return undefined;
  if (!trustedRanges.some(([range, prefix]) => peer.kind() === range.kind() && peer.match([range, prefix]))) return undefined;
  const expected = createHmac('sha256', secret).update(`${identity.timestamp}\n${identity.ip}`).digest();
  let actual: Buffer;
  try { actual = Buffer.from(identity.signature, 'base64url'); } catch { return undefined; }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return undefined;
  return client.toString();
}

export function trustedProxyConfiguration(environment: Record<string, string | undefined> = process.env): string[] {
  return (environment.REQUEST_RATE_TRUSTED_PROXY_CIDRS ?? '')
    .split(',').map(value => value.trim()).filter(value => value.length > 0 && value !== '*');
}

export function requestRatePolicyConfiguration(environment: Record<string, string | undefined> = process.env): Record<RateLimitClass, RatePolicy> {
  const policies = structuredClone(DEFAULT_POLICIES);
  const names: RateLimitClass[] = ['general', 'search', 'metadata', 'resolve', 'hls', 'admin'];
  for (const name of names) {
    const raw = Number(environment[`REQUEST_RATE_${name.toUpperCase()}_PER_MINUTE`]);
    if (Number.isFinite(raw) && raw > 0) {
      policies[name].perMinute = Math.min(6000, Math.max(1, Math.floor(raw)));
      policies[name].burst = Math.max(1, Math.min(policies[name].burst, Math.ceil(policies[name].perMinute / 3)));
    }
  }
  return policies;
}

export function globalRatePolicyConfiguration(environment: Record<string, string | undefined> = process.env): RatePolicy {
  const configured = Number(environment.REQUEST_RATE_GLOBAL_PER_MINUTE);
  return {
    perMinute: Number.isFinite(configured) && configured > 0 ? Math.min(20_000, Math.max(1, Math.floor(configured))) : 1200,
    burst: 120,
  };
}

export function rateLimitClass(pathname: string): RateLimitClass {
  let path = pathname;
  let action = '';
  try {
    const url = new URL(pathname, 'http://rate-limit.invalid');
    path = url.pathname;
    action = url.searchParams.get('action') ?? '';
  } catch { /* classify malformed values under the general API budget */ }
  if (/^\/api\/(?:hls|s)(?:\/|$)/.test(path) || /^\/api\/telegram\/media(?:\/|$)/.test(path)) return 'hls';
  if (/^\/api\/(?:stream\/|provider-stream(?:\/|$))/.test(path)) return 'resolve';
  if (/^\/api\/(?:subtitles\/admin|telegram\/admin)(?:\/|$)/.test(path)) return 'admin';
  if (/^\/api\/provider-catalog(?:\/|$)/.test(path)) return action === 'info' ? 'metadata' : 'search';
  if (/^\/api\/provider-options(?:\/|$)/.test(path)) return 'search';
  if (/^\/api\/(?:telegram\/catalog|subtitles\/providers)(?:\/|$)/.test(path)) return 'metadata';
  return 'general';
}

/** A bounded per-process token bucket. The socket peer must match a configured CIDR before CF-Connecting-IP is trusted. */
export function createRequestRateLimiter(options: RateLimitOptions = {}) {
  const policies = { ...DEFAULT_POLICIES, ...options.policies };
  const globalPolicy = options.globalPolicy ?? { perMinute: 1200, burst: 120 };
  const trustedRanges = parseTrustedRanges(options.trustedProxyCidrs ?? []);
  const proxySigningSecret = options.proxySigningSecret;
  const maxClients = Math.max(100, Math.min(100_000, Math.floor(options.maxClients ?? 20_000)));
  const idleMs = Math.max(60_000, Math.min(3_600_000, Math.floor(options.idleMs ?? 15 * 60_000)));
  const now = options.now ?? Date.now;
  const buckets = new Map<string, BucketState>();
  let operations = 0;

  function clientKey(peerValue: string | undefined, signedProxyIdentity: SignedProxyIdentity | undefined, at: number): string {
    const peer = parseAddress(peerValue);
    const identity = verifiedProxyAddress(peerValue, signedProxyIdentity, proxySigningSecret, trustedRanges, at) ?? peer?.toString() ?? 'unknown';
    return createHash('sha256').update(identity).digest('hex').slice(0, 32);
  }

  return {
    check(pathname: string, peerAddress: string | undefined, signedProxyIdentity?: SignedProxyIdentity, at = now()): RateLimitResult {
      const identity = clientKey(peerAddress, signedProxyIdentity, at);
      const endpointClass = rateLimitClass(pathname);
      const consume = (bucketClass: RateBucketClass, policy: RatePolicy): RateLimitResult => {
        const perMinute = Math.max(1, policy.perMinute);
        const burst = Math.max(1, policy.burst);
        const key = `${bucketClass}:${identity}`;
      let state = buckets.get(key);
      if (state && at - state.touchedAt > idleMs) { buckets.delete(key); state = undefined; }
      if (!state) {
        if (buckets.size >= maxClients) {
          const oldest = buckets.keys().next().value as string | undefined;
          if (oldest !== undefined) buckets.delete(oldest);
        }
        state = { tokens: burst, updatedAt: at, touchedAt: at };
      }
      const elapsedMs = Math.max(0, at - state.updatedAt);
      state.tokens = Math.min(burst, state.tokens + elapsedMs * perMinute / 60_000);
      state.updatedAt = at;
      state.touchedAt = at;
      const allowed = state.tokens >= 1;
      if (allowed) state.tokens -= 1;
      const retryAfterSeconds = allowed ? 0 : Math.max(1, Math.ceil((1 - state.tokens) * 60_000 / perMinute / 1000));
      buckets.delete(key);
      buckets.set(key, state);
      operations++;
      if (operations % 256 === 0) {
        for (const [candidate, candidateState] of buckets) {
          if (at - candidateState.touchedAt > idleMs) buckets.delete(candidate);
          else break;
        }
      }
        return { allowed, retryAfterSeconds, remaining: Math.max(0, Math.floor(state.tokens)), bucket: bucketClass };
      };
      const global = consume('global', globalPolicy);
      if (!global.allowed) return global;
      const endpoint = consume(endpointClass, policies[endpointClass] ?? DEFAULT_POLICIES[endpointClass]);
      return endpoint;
    },
    get size(): number { return buckets.size; },
  };
}

const processRateLimiter = createRequestRateLimiter({
  trustedProxyCidrs: trustedProxyConfiguration(),
  proxySigningSecret: process.env.ANINEKO_RATE_LIMIT_SIGNING_SECRET,
  policies: requestRatePolicyConfiguration(),
  globalPolicy: globalRatePolicyConfiguration(),
});

export function checkRequestRateLimit(pathname: string, peerAddress: string | undefined, signedProxyIdentity?: SignedProxyIdentity): RateLimitResult {
  return processRateLimiter.check(pathname, peerAddress, signedProxyIdentity);
}
