import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchPublic, issueManifestProxyToken, proxySubtitleTracks, ProxyError, proxyLimits, resolveManifestProxyToken, validateDestination } from '../hls-proxy';

const hosts = ['media.example.test', '*.segments.example.test'];
const resolver = async (_host: string, _options: { all: true; verbatim: true }) => [{ address: '93.184.216.34', family: 4 }];

test('accepts HTTPS on an exact allowlisted media host after public DNS validation', async () => {
  assert.deepEqual(await validateDestination(new URL('https://media.example.test/master.m3u8'), hosts, resolver), ['93.184.216.34']);
});

test('accepts globally routable IPv6 DNS answers', async () => {
  const ipv6Resolver = async () => [{ address: '2606:4700:3034::6815:4fd2', family: 6 }];
  assert.deepEqual(await validateDestination(new URL('https://media.example.test/master.m3u8'), hosts, ipv6Resolver), ['2606:4700:3034::6815:4fd2']);
});

test('manifest-issued tokens authorize rotating public segment hosts without a wildcard', async () => {
  const token = issueManifestProxyToken('https://rotating-cdn.example.test/segment.ts?sig=abc', 'https://player.example.test/');
  assert.deepEqual(resolveManifestProxyToken(token), { url: 'https://rotating-cdn.example.test/segment.ts?sig=abc', referer: 'https://player.example.test/' });
  assert.equal(resolveManifestProxyToken('unissued-token'), undefined);
  const response = await fetchPublic(new URL('https://rotating-cdn.example.test/segment.ts'), {}, [], new AbortController().signal, {
    manifestAuthorizedTarget: true, resolve: resolver, fetcher: async () => new Response(new Uint8Array([1, 2, 3])),
  });
  assert.equal(response.status, 200);
  await assert.rejects(() => fetchPublic(new URL('https://rotating-cdn.example.test/segment.ts'), {}, [], new AbortController().signal, {
    manifestAuthorizedTarget: true,
    resolve: async () => [{ address: '10.0.0.1', family: 4 }],
    fetcher: async () => new Response(new Uint8Array([1])),
  }), /non-public-destination/);
});

test('manifest token issuance rejects unsafe protocols and referers', () => {
  assert.throws(() => issueManifestProxyToken('http://rotating-cdn.example.test/segment.ts', ''), /invalid-manifest-target/);
  assert.throws(() => issueManifestProxyToken('https://rotating-cdn.example.test/segment.ts', 'http://player.example.test/'), /invalid-referer/);
});

test('provider subtitles are issued as same-origin proxy capabilities with their provider referer', () => {
  const tracks = proxySubtitleTracks([
    { lang: 'English', format: 'vtt', url: 'https://captions.example.test/tougen-anki-01.vtt?token=abc' },
    { lang: 'Broken', format: 'vtt', url: 'http://captions.example.test/bad.vtt' },
  ], 'https://embed.example.test/');
  assert.equal(tracks.length, 1);
  assert.match(tracks[0]!.url, /^\/api\/hls\?t=/);
  const token = new URL(tracks[0]!.url, 'https://anineko.test').searchParams.get('t')!;
  assert.deepEqual(resolveManifestProxyToken(token), {
    url: 'https://captions.example.test/tougen-anki-01.vtt?token=abc',
    referer: 'https://embed.example.test/',
  });
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

test('legacy HTTP is allowed only for an explicitly named provider host and still pins public DNS', async () => {
  assert.deepEqual(await validateDestination(new URL('http://subs.sab.bz/file.zip'), ['subs.sab.bz'], resolver, false, ['subs.sab.bz']), ['93.184.216.34']);
  await assert.rejects(() => validateDestination(new URL('http://evil.test/file.zip'), ['evil.test'], resolver, false, ['subs.sab.bz']), /https-required/);
  await assert.rejects(() => validateDestination(new URL('http://subs.sab.bz/file.zip'), ['subs.sab.bz'], async () => [{ address: '192.168.1.10', family: 4 }], false, ['subs.sab.bz']), /non-public-destination/);
});

test('legacy HTTP redirects remain constrained by exact host policy', async () => {
  let calls = 0;
  const fetcher = async () => {
    calls++;
    return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } });
  };
  await assert.rejects(() => fetchPublic(new URL('http://subs.sab.bz/file.zip'), {}, ['subs.sab.bz'], new AbortController().signal, {
    allowHttpHosts: ['subs.sab.bz'], resolve: resolver, fetcher,
  }), /https-required|host-not-allowed|non-public-destination/);
  assert.equal(calls, 1);
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

test('waiters honor the configured active cap and cancellation removes them from the queue', async () => {
  let releaseFirst!: () => void;
  const firstHold = new Promise<void>(resolve => { releaseFirst = resolve; });
  let secondStarted = false;
  const runtime = { resolve: resolver, maxActive: 1, maxWaiting: 2, fetcher: async (_url: URL) => {
    if (!secondStarted) { await firstHold; return new Response('first'); }
    return new Response('second');
  } };
  const first = fetchPublic(new URL('https://media.example.test/first.ts'), {}, hosts, new AbortController().signal, runtime);
  await new Promise(resolve => setTimeout(resolve, 5));
  const cancelled = new AbortController();
  const queued = fetchPublic(new URL('https://media.example.test/queued.ts'), {}, hosts, cancelled.signal, runtime);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(proxyLimits().active, 1);
  assert.equal(proxyLimits().waiting, 1);
  cancelled.abort();
  await assert.rejects(() => queued, /client-cancelled/);
  assert.equal(proxyLimits().waiting, 0);
  releaseFirst();
  await first;

  secondStarted = true;
  const next = await fetchPublic(new URL('https://media.example.test/next.ts'), {}, hosts, new AbortController().signal, runtime);
  assert.equal(next.status, 200);
});
