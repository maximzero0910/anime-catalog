import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createRequestRateLimiter, globalRatePolicyConfiguration, rateLimitClass, requestRatePolicyConfiguration, trustedProxyConfiguration } from '../request-rate-limit';

test('endpoint classes separate search, stream resolution, HLS segments, and admin polling', () => {
  assert.equal(rateLimitClass('/api/provider-catalog?action=search'), 'search');
  assert.equal(rateLimitClass('/api/provider-catalog?action=info'), 'metadata');
  assert.equal(rateLimitClass('/api/telegram/catalog/21'), 'metadata');
  assert.equal(rateLimitClass('/api/provider-options/21/1'), 'search');
  assert.equal(rateLimitClass('/api/stream/21/1'), 'resolve');
  assert.equal(rateLimitClass('/api/hls?u=https%3A%2F%2Fcdn.test%2Findex.m3u8'), 'hls');
  assert.equal(rateLimitClass('/api/telegram/media/42'), 'hls');
  assert.equal(rateLimitClass('/api/subtitles/admin'), 'admin');
  assert.equal(rateLimitClass('/api/subtitles/123/1'), 'general');
});

test('token buckets enforce the configured burst, refill over time, and remain bounded', () => {
  const limiter = createRequestRateLimiter({
    policies: { search: { perMinute: 60, burst: 2 } },
    maxClients: 100,
    now: () => 0,
  });
  assert.equal(limiter.check('/api/provider-catalog', '192.0.2.1', undefined, 0).allowed, true);
  assert.equal(limiter.check('/api/provider-catalog', '192.0.2.1', undefined, 0).allowed, true);
  const limited = limiter.check('/api/provider-catalog', '192.0.2.1', undefined, 0);
  assert.equal(limited.allowed, false);
  assert.equal(limited.retryAfterSeconds, 1);
  assert.equal(limiter.check('/api/provider-catalog', '192.0.2.1', undefined, 1000).allowed, true);

  for (let i = 0; i < 150; i++) limiter.check('/api/provider-catalog', `2001:db8::${i + 1}`, undefined, i + 2000);
  assert.ok(limiter.size <= 100);
});

test('the global budget aggregates traffic across independently budgeted endpoints', () => {
  const limiter = createRequestRateLimiter({
    globalPolicy: { perMinute: 60, burst: 2 },
    policies: {
      search: { perMinute: 60, burst: 10 },
      metadata: { perMinute: 60, burst: 10 },
    },
  });
  assert.equal(limiter.check('/api/provider-catalog', '192.0.2.4', undefined, 0).allowed, true);
  assert.equal(limiter.check('/api/telegram/catalog/21', '192.0.2.4', undefined, 0).allowed, true);
  const result = limiter.check('/api/provider-catalog', '192.0.2.4', undefined, 0);
  assert.equal(result.allowed, false);
  assert.equal(result.bucket, 'global');
});

test('signed Pages client identity is honored only from a configured proxy peer', () => {
  const secret = 'a-reliable-test-secret-with-at-least-32-bytes';
  const signed = (ip: string, timestamp: string) => ({ ip, timestamp, signature: createHmac('sha256', secret).update(`${timestamp}\n${ip}`).digest('base64url') });
  const limiter = createRequestRateLimiter({
    trustedProxyCidrs: ['127.0.0.1/32', '::1/128'],
    proxySigningSecret: secret,
    policies: { search: { perMinute: 60, burst: 1 } },
  });
  const at = 1_700_000_000_000;
  const timestamp = String(at);
  assert.equal(limiter.check('/api/provider-catalog', '127.0.0.1', signed('198.51.100.1', timestamp), at).allowed, true);
  assert.equal(limiter.check('/api/provider-catalog', '127.0.0.1', signed('198.51.100.2', timestamp), at).allowed, true);
  assert.equal(limiter.check('/api/provider-catalog', '203.0.113.10', signed('198.51.100.3', timestamp), at).allowed, true);
  assert.equal(limiter.check('/api/provider-catalog', '203.0.113.10', signed('198.51.100.4', timestamp), at).allowed, false);
  assert.equal(limiter.check('/api/provider-catalog', '127.0.0.1', undefined, at).allowed, true);
  assert.equal(limiter.check('/api/provider-catalog', '127.0.0.1', signed('198.51.100.5', String(at - 60_001)), at).allowed, false);
});

test('rate-limit environment values are clamped and proxy wildcards are rejected', () => {
  const policies = requestRatePolicyConfiguration({ REQUEST_RATE_SEARCH_PER_MINUTE: '999999' });
  assert.equal(policies.search.perMinute, 6000);
  assert.equal(globalRatePolicyConfiguration({ REQUEST_RATE_GLOBAL_PER_MINUTE: '999999' }).perMinute, 20000);
  assert.equal(trustedProxyConfiguration({ REQUEST_RATE_TRUSTED_PROXY_CIDRS: '*,127.0.0.1/32' }).join(','), '127.0.0.1/32');
});
