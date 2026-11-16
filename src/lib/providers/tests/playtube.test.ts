import test from 'node:test';
import assert from 'node:assert/strict';
import playtube, { extractChannelVideos, parseVideoTitle } from '../playtube';

test('PlayTube parses Bulgarian season and episode labels without browser execution', () => {
  const parsed = parseVideoTitle('Възходът на книгоманката - сезон 4 епизод 24 [Бг субтитри]', 'https://playtube.tv/watch/test.html', '42');
  assert.deepEqual(parsed && { series: parsed.series, season: parsed.season, num: parsed.num }, { series: 'Възходът на книгоманката Season 4', season: 4, num: 24 });
  assert.equal(parseVideoTitle('Безсмъртният - част 5 [Бг субтитри]', 'https://playtube.tv/watch/part.html', '43'), null);
});

test('PlayTube channel cards are restricted to Belion and yield a playable upload', async () => {
  const channel = await fetch('https://playtube.tv/@Belion');
  assert.equal(channel.status, 200);
  const videos = extractChannelVideos(await channel.text());
  assert.ok(videos.length > 0);
  assert.ok(videos.every(video => video.url.startsWith('https://playtube.tv/watch/')));

  const hits = await playtube.searchByTitle('Възходът на книгоманката');
  const hit = hits.find(item => item.title.startsWith('Възходът на книгоманката'));
  assert.ok(hit, 'expected Belion upload for the Bulgarian title');
  const episodes = await playtube.listEpisodes(hit.id);
  const episode = episodes.find(item => item.num === 24);
  assert.ok(episode, 'expected season 4 episode 24');
  const [source] = await playtube.resolve(episode.id, 'sub');
  assert.ok(source);
  assert.equal(source.type, 'mp4');
  assert.match(source.url, /^https:\/\//);
  assert.equal(source.provider, 'playtube');
});
