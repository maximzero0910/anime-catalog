import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDestination, fetchPublic, ProxyError, proxyLimits } from '../hls-proxy';

const hosts = ['media.example.test', '*.segments.example.test'];
const resolver = async (_host: string, _options: { all: true; verbatim: true }) => [{ address: '93.184.216.34', family: 4 }];

test('accepts HTTPS on an exact allowlisted media host after public DNS validation', async () => {
  assert.deepEqual(await validateDestination(new URL('https://media.example.test/master.m3u8'), hosts, resolver), ['93.184.216.34']);
});

test('scoped rotating segment zone accepts subdomains but not unrelated suffixes or apex', async () => {
  await validateDestination(new URL('https://one.segments.example.test/seg.ts'), hosts, resolver);
  await assert.rejects(() => validateDestination(new URL('https://segments.example.test/seg.ts'), hosts, resolver), ProxyError);
  await assert.rejects(() => validateDestination(new URL('https://segments.example.test.evil.test/seg.ts'), hosts, resolver), ProxyError);
});

test('rejects HTTP, credentials, localhost, private IPv4 and alternate IPv4 notation', async () => {
  for (const value of ['http://media.example.test/a.m3u8', 'https://u:p@media.example.test/a.m3u8', 'https://127.0.0.1/a', 'https://2130706433/a', 'https://10.1.2.3/a']) {
    await assert.rejects(() => validateDestination(new URL(value), ['media.example.test'], resolver));
  }
});

test('rejects loopback, link-local, mapped private and unique-local IPv6 literals', async () => {
  for (const value of ['https://[::1]/a', 'https://[fe80::1]/a', 'https://[::ffff:127.0.0.1]/a', 'https://[fc00::1]/a']) {
    await assert.rejects(() => validateDestination(new URL(value), ['::1', 'fe80::1', '::ffff:127.0.0.1', 'fc00::1'], resolver));
  }
});

test('rejects a public host if any DNS answer is non-public (rebinding defense)', async () => {
  const mixed = async () => [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }];
  await assert.rejects(() => validateDestination(new URL('https://media.example.test/a'), hosts, mixed), /non-public-destination/);
});

test('rejects DNS answers in reserved ranges and DNS failures', async () => {
  for (const address of ['169.254.1.2', '192.168.1.1', '224.0.0.1', '0.0.0.0']) {
    const privateResolver = async () => [{ address, family: 4 }];
    await assert.rejects(() => validateDestination(new URL('https://media.example.test/a'), hosts, privateResolver));
  }
  await assert.rejects(() => validateDestination(new URL('https://media.example.test/a'), hosts, async () => { throw new Error('dns failed'); }), /dns-resolution-failed/);
});

test('follows a bounded redirect chain only after revalidating each destination', async () => {
  const calls: string[] = [];
  const fetcher = async (url: URL) => {
    calls.push(url.href);
    return calls.length === 1
      ? new Response(null, { status: 302, headers: { location: 'https://one.segments.example.test/final.ts' } })
      : new Response(new Uint8Array([1, 2, 3]));
  };
  const response = await fetchPublic(new URL('https://media.example.test/start.ts'), {}, hosts, new AbortController().signal, { resolve: resolver, fetcher });
  assert.deepEqual(calls, ['https://media.example.test/start.ts', 'https://one.segments.example.test/final.ts']);
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [1, 2, 3]);
});

test('redirect to an untrusted host or private DNS destination is rejected', async () => {
  const redirect = async () => new Response(null, { status: 302, headers: { location: 'https://evil.example.test/x' } });
  await assert.rejects(() => fetchPublic(new URL('https://media.example.test/a'), {}, hosts, new AbortController().signal, { resolve: resolver, fetcher: redirect }), /host-not-allowed/);
  const privateResolve = async (host: string) => host === 'media.example.test' ? [{ address: '93.184.216.34', family: 4 }] : [{ address: '10.0.0.2', family: 4 }];
  const privateRedirect = async () => new Response(null, { status: 302, headers: { location: 'https://one.segments.example.test/x' } });
  await assert.rejects(() => fetchPublic(new URL('https://media.example.test/a'), {}, hosts, new AbortController().signal, { resolve: privateResolve, fetcher: privateRedirect }), /non-public-destination/);
});

test('stops redirect loops at the configured hop ceiling', async () => {
  let calls = 0;
  const fetcher = async () => { calls++; return new Response(null, { status: 302, headers: { location: '/again' } }); };
  await assert.rejects(() => fetchPublic(new URL('https://media.example.test/a'), {}, hosts, new AbortController().signal, { resolve: resolver, fetcher }), /redirect-limit/);
  assert.equal(calls, 4);
});

test('enforces response size caps and propagates upstream HTTP failures', async () => {
  const oversized = new Response(new Uint8Array(32 * 1024 * 1024 + 1));
  await assert.rejects(() => fetchPublic(new URL('https://media.example.test/seg.ts'), {}, hosts, new AbortController().signal, { resolve: resolver, fetcher: async () => oversized }), /upstream-response-too-large/);
  const failed = await fetchPublic(new URL('https://media.example.test/seg.ts'), {}, hosts, new AbortController().signal, { resolve: resolver, fetcher: async () => new Response('unavailable', { status: 503 }) });
  assert.equal(failed.status, 503);
});

test('enforces per-request timeouts and releases queue slots after cancellation', async () => {
  await assert.rejects(() => fetchPublic(new URL('https://media.example.test/a'), {}, hosts, new AbortController().signal, {
    resolve: resolver, requestTimeoutMs: 15, totalTimeoutMs: 25,
    fetcher: async (_url, init) => await new Promise((_resolve, reject) => (init.signal as AbortSignal).addEventListener('abort', () => reject(new Error('aborted')), { once: true })),
  }), /upstream-timeout/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(() => fetchPublic(new URL('https://media.example.test/a'), {}, hosts, controller.signal, { resolve: resolver }), /client-cancelled/);
  assert.ok(proxyLimits().active >= 0 && proxyLimits().waiting >= 0);
});

test('cancels an active upstream request when the browser disconnects', async () => {
  const controller = new AbortController(); let observedAbort = false;
  const pending = fetchPublic(new URL('https://media.example.test/a'), {}, hosts, controller.signal, {
    resolve: resolver,
    fetcher: async (_url, init) => await new Promise((_resolve, reject) => (init.signal as AbortSignal).addEventListener('abort', () => { observedAbort = true; reject(new Error('cancelled')); }, { once: true })),
  });
  await new Promise(resolve => setTimeout(resolve, 5)); controller.abort();
  await assert.rejects(() => pending, /client-cancelled/);
  assert.equal(observedAbort, true);
});

test('rejects immediately when active and bounded waiting capacity are full', async () => {
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const runtime = { resolve: resolver, maxActive: 1, maxWaiting: 0, fetcher: async () => { await blocked; return new Response('ok'); } };
  const first = fetchPublic(new URL('https://media.example.test/a'), {}, hosts, new AbortController().signal, runtime);
  await new Promise(resolve => setTimeout(resolve, 10));
  await assert.rejects(() => fetchPublic(new URL('https://media.example.test/b'), {}, hosts, new AbortController().signal, runtime), /proxy-overloaded/);
  release(); await first;
});
