import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../index';

const env = { RESOLVER: 'https://resolver.example.test', HLS_ALLOWED_HOSTS: 'media.example.test,*.segments.example.test' };
const request = (path: string) => new Request(`https://worker.example.test${path}`);

test('Worker proxy rejects arbitrary and malformed URLs before outbound fetch', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return new Response('should not fetch'); }) as typeof fetch;
  try {
    for (const value of ['https://evil.example/a', 'http://media.example.test/a', 'https://127.0.0.1/a', 'https://[::1]/a', 'not a URL']) {
      const response = await worker.fetch(request(`/api/hls?u=${encodeURIComponent(value)}`), env as never);
      assert.ok(response.status === 400 || response.status === 403);
    }
    assert.equal(calls, 0);
  } finally { globalThis.fetch = original; }
});

test('Worker proxy revalidates redirects and rejects internal redirect targets', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1/internal' } }); }) as typeof fetch;
  try {
    const response = await worker.fetch(request(`/s?u=${encodeURIComponent('https://media.example.test/file.ts')}`), env as never);
    assert.equal(response.status, 403);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});

test('Worker proxy preserves trusted provider HLS manifest rewriting', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    assert.equal(new URL(String(input)).hostname, 'media.example.test');
    return new Response('#EXTM3U\n#EXTINF:4,\nseg-1.ts\n#EXT-X-ENDLIST', { headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } });
  }) as typeof fetch;
  try {
    const response = await worker.fetch(request(`/api/hls?u=${encodeURIComponent('https://media.example.test/master.m3u8')}`), env as never);
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.match(text, /^#EXTM3U/);
    assert.match(text, /\/api\/hls\?u=https%3A%2F%2Fmedia\.example\.test%2Fseg-1\.ts/);
  } finally { globalThis.fetch = original; }
});

test('Worker manifest streaming enforces the cap before buffering chunked bodies', async () => {
  const original = globalThis.fetch;
  let sent = 0;
  let cancelled = false;
  globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= 2 * 1_048_576) { controller.close(); return; }
      sent += 64 * 1024;
      controller.enqueue(new Uint8Array(64 * 1024).fill(65));
    },
    cancel() { cancelled = true; },
  }), { headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } })) as typeof fetch;
  try {
    const response = await worker.fetch(request(`/api/hls?u=${encodeURIComponent('https://media.example.test/master.m3u8')}`), env as never);
    assert.equal(response.status, 413);
    // ReadableStream may prefill its one-chunk queue while the consumer detects the cap.
    assert.ok(sent <= 1_048_576 + 2 * 64 * 1024);
    assert.equal(cancelled, true);
  } finally { globalThis.fetch = original; }
});

test('legacy /s does not turn failed or malformed manifests into successful playlists', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response('upstream unavailable', { status: 503, headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } })) as typeof fetch;
  try {
    const failed = await worker.fetch(request(`/s?u=${encodeURIComponent('https://media.example.test/master.m3u8')}`), env as never);
    assert.equal(failed.status, 503);
    assert.equal(await failed.text(), '');
  } finally { globalThis.fetch = original; }

  globalThis.fetch = (async () => new Response('<html>blocked</html>', { status: 200, headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } })) as typeof fetch;
  try {
    const malformed = await worker.fetch(request(`/s?u=${encodeURIComponent('https://media.example.test/master.m3u8')}`), env as never);
    assert.equal(malformed.status, 502);
    assert.match(await malformed.text(), /invalid HLS manifest/);
  } finally { globalThis.fetch = original; }
});

test('legacy /s segment route preserves Range and streams bytes for the trusted segment zone', async () => {
  const original = globalThis.fetch; let observedRange = '';
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    observedRange = new Headers(init?.headers).get('Range') ?? '';
    return new Response(new Uint8Array([71, 0, 1]), { status: 206, headers: { 'Content-Type': 'video/mp2t', 'Content-Range': 'bytes 0-2/3', 'Accept-Ranges': 'bytes' } });
  }) as typeof fetch;
  try {
    const response = await worker.fetch(new Request(`https://worker.example.test/s?u=${encodeURIComponent('https://one.segments.example.test/seg.ts')}`, { headers: { Range: 'bytes=0-2' } }), env as never);
    assert.equal(response.status, 206);
    assert.equal(observedRange, 'bytes=0-2');
    assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [71, 0, 1]);
  } finally { globalThis.fetch = original; }
});

test('Worker proxy rejects empty host policy closed', async () => {
  const response = await worker.fetch(request(`/s?u=${encodeURIComponent('https://media.example.test/seg.ts')}`), { RESOLVER: env.RESOLVER } as never);
  assert.equal(response.status, 503);
});

test('resolver calls stop at the configured deadline', async () => {
  const originalFetch = globalThis.fetch;
  const originalTimeout = AbortSignal.timeout;
  globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  })) as typeof fetch;
  Object.defineProperty(AbortSignal, 'timeout', { configurable: true, value: (_milliseconds: number) => originalTimeout(5) });
  try {
    const response = await worker.fetch(request('/api/anime/anikoto/search?q=example'), env as never);
    assert.equal(response.status, 504);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(AbortSignal, 'timeout', { configurable: true, value: originalTimeout });
  }
});

test('resolver response content length is capped before buffering', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response('', { headers: { 'Content-Length': String(4 * 1_048_576 + 1) } })) as typeof fetch;
  try {
    const response = await worker.fetch(request('/api/anime/anikoto/search?q=example'), env as never);
    assert.equal(response.status, 502);
    assert.match(await response.text(), /upstreamStatus/);
  } finally { globalThis.fetch = original; }
});

test('malformed resolver source JSON becomes a safe playback error', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response('{not json', { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
  try {
    const response = await worker.fetch(request('/p/anikoto/episode-1'), env as never);
    assert.equal(response.status, 502);
    assert.match(await response.text(), /malformed JSON/);
  } finally { globalThis.fetch = original; }
});

test('client cancellation is propagated to resolver requests', async () => {
  const original = globalThis.fetch;
  const controller = new AbortController();
  globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    setTimeout(() => controller.abort(), 1);
  })) as typeof fetch;
  try {
    const cancelledRequest = new Request('https://worker.example.test/api/anime/anikoto/search?q=example', { signal: controller.signal });
    const response = await worker.fetch(cancelledRequest, env as never);
    assert.equal(response.status, 499);
  } finally { globalThis.fetch = original; }
});
