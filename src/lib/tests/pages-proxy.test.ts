import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { onRequest } from '../../../functions/api/[[path]]';

const env = { ANINEKO_API_ORIGIN: 'https://api.example.test/', ANINEKO_API_TIMEOUT_MS: '100' };

test('Pages proxy fails closed with an explicit no-store 503 when backend origin is unset', async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = (async () => { called = true; throw new Error('must not fetch'); }) as typeof fetch;
  try {
    const response = await onRequest({ request: new Request('https://anineko.eu/api/health/live'), env: {} });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { error: 'backend-unavailable' });
    assert.equal(called, false);
  } finally { globalThis.fetch = originalFetch; }
});

test('Pages proxy forwards API requests to configured HTTPS origin and preserves the response stream', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async request => {
    assert.equal((request as Request).url, 'https://api.example.test/api/health/live');
    return Response.json({ status: 'live' }, { headers: { 'cache-control': 'no-store' } });
  }) as typeof fetch;
  try {
    const response = await onRequest({ request: new Request('https://anineko.eu/api/health/live'), env });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'live' });
    assert.equal(response.headers.get('cache-control'), 'no-store');
  } finally { globalThis.fetch = originalFetch; }
});

test('Pages proxy replaces spoofable identity headers with a signed Cloudflare ingress address', async () => {
  const originalFetch = globalThis.fetch;
  const secret = 'pages-and-origin-share-a-secret-that-is-at-least-32-bytes';
  const envWithSigningKey = { ...env, ANINEKO_RATE_LIMIT_SIGNING_SECRET: secret };
  globalThis.fetch = (async request => {
    const headers = (request as Request).headers;
    assert.equal(headers.get('cf-connecting-ip'), null);
    assert.equal(headers.get('x-real-ip'), null);
    assert.equal(headers.get('x-anineko-client-ip'), '198.51.100.22');
    const timestamp = headers.get('x-anineko-client-timestamp')!;
    const signature = headers.get('x-anineko-client-signature');
    assert.match(timestamp, /^\d{13}$/);
    assert.equal(signature, createHmac('sha256', secret).update(`${timestamp}\n198.51.100.22`).digest('base64url'));
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  try {
    const request = new Request('https://anineko.eu/api/health/live', { headers: {
      'cf-connecting-ip': '198.51.100.22',
      'x-real-ip': '203.0.113.99',
      'x-anineko-client-ip': '203.0.113.88',
      'x-anineko-client-timestamp': '1',
      'x-anineko-client-signature': 'spoofed',
    } });
    const response = await onRequest({ request, env: envWithSigningKey });
    assert.equal(response.status, 204);
  } finally { globalThis.fetch = originalFetch; }
});

test('Pages proxy turns a stalled backend into a bounded 504', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((request: RequestInfo | URL) => new Promise<Response>((_resolve, reject) => {
    (request as Request).signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  })) as typeof fetch;
  try {
    const response = await onRequest({ request: new Request('https://anineko.eu/api/stall'), env });
    assert.equal(response.status, 504);
    assert.deepEqual(await response.json(), { error: 'backend-timeout' });
  } finally { globalThis.fetch = originalFetch; }
});

test('Pages proxy cancels a pending upstream request when the browser disconnects', async () => {
  const originalFetch = globalThis.fetch;
  const client = new AbortController();
  globalThis.fetch = ((request: RequestInfo | URL) => new Promise<Response>((_resolve, reject) => {
    (request as Request).signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  })) as typeof fetch;
  try {
    const pending = onRequest({ request: new Request('https://anineko.eu/api/stall', { signal: client.signal }), env });
    await new Promise(resolve => setTimeout(resolve, 0));
    client.abort();
    const response = await pending;
    assert.equal(response.status, 499);
    assert.deepEqual(await response.json(), { error: 'request-cancelled' });
  } finally { globalThis.fetch = originalFetch; }
});

test('Pages proxy cancellation closes an already-open streamed backend body', async () => {
  const originalFetch = globalThis.fetch;
  let cancelled = false;
  globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
    pull() { return new Promise<void>(() => undefined); },
    cancel() { cancelled = true; },
  }))) as typeof fetch;
  try {
    const response = await onRequest({ request: new Request('https://anineko.eu/api/telegram/media/10'), env });
    await response.body?.cancel();
    assert.equal(cancelled, true);
  } finally { globalThis.fetch = originalFetch; }
});
