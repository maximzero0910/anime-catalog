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
