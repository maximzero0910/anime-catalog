import { defineMiddleware } from 'astro:middleware';
import { checkRequestRateLimit } from './lib/request-rate-limit';

const rejectedByBucket = new Map<string, number>();
let lastRateLimitLogAt = Date.now();

export const onRequest = defineMiddleware(async (context, next) => {
  const pathname = context.url.pathname;
  if (!pathname.startsWith('/api/')) return next();

  // Astro's Node adapter sets clientAddress from the socket peer while security.allowedDomains is empty.
  // Trust CF-Connecting-IP only when that peer matches REQUEST_RATE_TRUSTED_PROXY_CIDRS.
  const result = checkRequestRateLimit(
    `${pathname}${context.url.search}`,
    context.clientAddress,
    {
      ip: context.request.headers.get('x-anineko-client-ip'),
      timestamp: context.request.headers.get('x-anineko-client-timestamp'),
      signature: context.request.headers.get('x-anineko-client-signature'),
    },
  );
  if (!result.allowed) {
    rejectedByBucket.set(result.bucket, (rejectedByBucket.get(result.bucket) ?? 0) + 1);
    const now = Date.now();
    if (now - lastRateLimitLogAt >= 60_000) {
      console.warn(JSON.stringify({ event: 'api_rate_limit_summary', rejectedByBucket: Object.fromEntries(rejectedByBucket) }));
      rejectedByBucket.clear();
      lastRateLimitLogAt = now;
    }
    return Response.json({ error: 'rate-limited', retryAfterSeconds: result.retryAfterSeconds }, {
      status: 429,
      headers: {
        'cache-control': 'no-store',
        'retry-after': String(result.retryAfterSeconds),
        'x-anineko-rate-limit-class': result.bucket,
        'ratelimit-remaining': '0',
      },
    });
  }

  return next();
});
