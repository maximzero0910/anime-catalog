import { createHash, timingSafeEqual } from 'node:crypto';

// Placeholder values copied from .env.example must never count as a configured
// admin token; deployments that never replaced them must fail closed.
const PLACEHOLDER_TOKEN = /replace[-_ ]?with|placeholder|change[-_ ]?me|your[-_ ]?token|example[-_ ]?token/i;

function bearerToken(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (!header) return null;
  const match = /^\s*Bearer\s+(.+?)\s*$/i.exec(header);
  const value = match?.[1]?.trim() ?? '';
  return value || null;
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

export function adminTokenConfigured(expected: string | undefined): boolean {
  const value = (expected ?? '').trim();
  return value.length > 0 && !PLACEHOLDER_TOKEN.test(value);
}

/**
 * Bearer-token-only authorization for administrative endpoints.
 *
 * Every request is denied unless a non-placeholder token is configured and the
 * supplied bearer credential matches it. Comparison is constant time: both sides
 * are SHA-256 digests, so unequal lengths are handled safely and no length or
 * prefix information leaks. Host, Origin and Referer are deliberately not
 * consulted. Behind the Cloudflare tunnel and Pages function proxy the request
 * URL always carries the server's loopback binding, so those checks can never
 * fail there; they must not stand in for a credential.
 */
export function adminAuthorized(request: Request, expected: string | undefined): boolean {
  if (!adminTokenConfigured(expected)) return false;
  const provided = bearerToken(request);
  if (!provided) return false;
  return timingSafeEqual(digest(provided), digest((expected ?? '').trim()));
}
