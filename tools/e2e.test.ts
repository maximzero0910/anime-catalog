import assert from 'node:assert/strict';
import test from 'node:test';

const resolver = process.env.RESOLVER ?? 'http://127.0.0.1:3000';
const worker = process.env.WORKER_URL ?? 'http://127.0.0.1:8787';
const pages = process.env.PAGES_URL ?? 'http://127.0.0.1:4321';
const animeId = 'cowboy-bebop-kb7hu';
const episodeId = `${animeId}$episode$1`;

async function json<T>(url: string): Promise<T> {
  const response = await fetch(url);
  assert.equal(response.status, 200, `${url} returned ${response.status}`);
  return response.json() as Promise<T>;
}

test('search returns actual resolver metadata through the Worker', async () => {
  const response = await fetch(`${worker}/api/anime/anikoto/Cowboy%20Bebop`);
  assert.equal(response.status, 200);
  const payload = await response.json() as { results?: Array<{ id: string }> };
  assert.ok(payload.results?.some(result => result.id === animeId));
});

test('provider search and metadata report their actual per-provider state', async () => {
  const expected = [
    { provider: 'anikoto', infoStatus: 200 },
    { provider: 'animeworld', infoStatus: 200 },
    { provider: 'animesaturn', infoStatus: 200 },
    { provider: 'reanime', infoStatus: 200 },
    { provider: 'gogoanime', infoStatus: null },
    { provider: 'miruro', infoStatus: 500 },
  ];
  for (const item of expected) {
    const search = await fetch(`${worker}/api/anime/${item.provider}/Cowboy%20Bebop`);
    assert.equal(search.status, 200, `${item.provider} search route`);
    const results = (await search.json() as { results?: Array<{ id: string }> }).results ?? [];
    if (item.provider === 'gogoanime') { assert.equal(results.length, 0); continue; }
    assert.ok(results.length, `${item.provider} search returned no titles`);
    const info = await fetch(`${worker}/api/anime/${item.provider}/info?id=${encodeURIComponent(results[0]!.id)}`);
    assert.equal(info.status, item.infoStatus, `${item.provider} metadata`);
    if (info.ok) {
      const metadata = await info.json() as { episodes?: Array<{ id: string }> };
      assert.ok(metadata.episodes?.length, `${item.provider} returned no episodes`);
    }
  }
});

test('anime detail and episode list resolve independently of source playback', async () => {
  const info = await json<{ title: string; episodes?: Array<{ id: string; number: number }> }>(
    `${resolver}/anime/anikoto/info?id=${encodeURIComponent(animeId)}`,
  );
  assert.match(info.title, /Cowboy Bebop/i);
  assert.ok(info.episodes?.some(episode => episode.id === episodeId && episode.number === 1));
  const detail = await fetch(`${pages}/anime/1/`);
  assert.equal(detail.status, 200);
  assert.match(await detail.text(), /Cowboy Bebop/i);
  const watch = await fetch(`${pages}/watch/1/1/`);
  assert.equal(watch.status, 200);
  assert.match(await watch.text(), /video-frame|iframe/);
});

test('authorized provider source metadata and media access (opt-in)', { skip: process.env.AUTHORIZED_MEDIA_TEST !== '1' }, async () => {
  const provider = process.env.AUTHORIZED_PROVIDER;
  const episode = process.env.AUTHORIZED_EPISODE_ID;
  assert.ok(provider && episode, 'Set AUTHORIZED_PROVIDER and AUTHORIZED_EPISODE_ID for a source you may access');
  const response = await fetch(`${resolver}/anime/${encodeURIComponent(provider)}/watch/${encodeURIComponent(episode)}`);
  assert.equal(response.status, 200);
  const payload = await response.json() as { sources?: Array<{ url: string; type?: string; isM3U8?: boolean; headers?: Record<string, string> }> };
  assert.ok(payload.sources?.length, 'resolver returned no sources');
  const source = payload.sources[0]!;
  const kind = source.isM3U8 || source.url.split('?')[0]?.endsWith('.m3u8') ? 'hls' : source.url.split('?')[0]?.endsWith('.mp4') ? 'mp4' : source.type ?? 'unknown';
  const host = new URL(source.url).host;
  console.info(`[E2E] provider=${provider} stage=source-metadata format=${kind} host=${host} headerNames=${Object.keys(source.headers ?? {}).join(',') || 'none'}`);
  const playback = await fetch(`${worker}/api/hls/${encodeURIComponent(provider)}/${encodeURIComponent(episode)}`, { method: 'HEAD' });
  assert.ok(playback.ok, `Worker media preflight returned ${playback.status}`);
  assert.match(playback.headers.get('content-type') ?? '', /video|mpegurl/i);
});

test('known Anikoto source extraction failure is distinguishable from episode extraction', async () => {
  const response = await fetch(`${worker}/api/anime/anikoto/watch/${encodeURIComponent(episodeId)}`);
  assert.equal(response.status, 500);
  const body = await response.json() as { diagnostic?: string; message?: string };
  assert.ok(body.diagnostic, 'Worker should give a safe diagnostic without exposing a stack trace');
});
