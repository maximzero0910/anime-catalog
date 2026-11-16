import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import { parseTelegramMedia, scoreTelegramTitle } from '../src/lib/telegram/matching';
import { upsertTelegramAlias } from '../src/lib/telegram/storage';

if (existsSync('.env')) loadEnvFile('.env');

interface AniListMedia {
  id: number; siteUrl: string; title: { romaji: string | null; english: string | null; native: string | null };
  coverImage?: { extraLarge?: string | null }; bannerImage?: string | null; episodes?: number | null; format?: string | null;
  seasonYear?: number | null; averageScore?: number | null; status?: string | null; season?: string | null;
  genres?: string[]; tags?: Array<{ name: string }>; synonyms?: string[];
}
interface Message { channel_id: string; message_id: number; filename: string; caption: string; duration_seconds: number | null; }
const db = new Database(resolve(process.env.CATALOG_DB_PATH ?? 'data/catalog.db'), { timeout: 10_000 });
db.pragma('busy_timeout = 10000');
const messages = db.prepare('SELECT channel_id,message_id,filename,caption,duration_seconds FROM telegram_messages ORDER BY message_id').all() as Message[];
const insertTitle = db.prepare(`INSERT INTO titles(id,slug,romaji,english,native,title_bg,synopsis_bg,year,format,episodes,cover,banner,status,score,season,genres,tags)
  VALUES(@id,@slug,@romaji,@english,@native,NULL,NULL,@year,@format,@episodes,@cover,@banner,@status,@score,@season,@genres,@tags)
  ON CONFLICT(id) DO NOTHING`);
const insertEpisode = db.prepare('INSERT OR IGNORE INTO episodes(title_id,number,duration,filler) VALUES(?,?,NULL,0)');
const query = `query($search:String!){Page(perPage:12){media(search:$search,type:ANIME){id siteUrl title{romaji english native} coverImage{extraLarge} bannerImage episodes format seasonYear averageScore status season genres tags{name}}}}`;
const normalize = (value: string) => value.toLocaleLowerCase().normalize('NFKD').replace(/\p{Diacritic}/gu, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const keyOf = (value: string) => value.toLocaleLowerCase().normalize('NFKD').replace(/\p{Diacritic}/gu, '').replace(/[.,:;_\-–—△？?]+/gu, ' ').replace(/\s+/g, ' ').trim();
const namesOf = (media: AniListMedia) => [media.title.romaji, media.title.english, media.title.native, ...(media.synonyms ?? [])].filter((value): value is string => Boolean(value));
const pause = (ms: number) => new Promise(resolveDelay => setTimeout(resolveDelay, ms));
let lastRequest = 0;
async function searchAniListBatch(terms: string[]): Promise<Map<string, AniListMedia[]>> {
  await pause(Math.max(0, 750 - (Date.now() - lastRequest)));
  const variables: Record<string, string> = {};
  const fields = terms.map((term, index) => {
    variables[`q${index}`] = term;
    return `p${index}:Page(perPage:12){media(search:$q${index},type:ANIME){id siteUrl title{romaji english native} synonyms coverImage{extraLarge} bannerImage episodes format seasonYear averageScore status season genres tags{name}}}`;
  });
  const batchQuery = `query(${terms.map((_, index) => `$q${index}:String!`).join(',')}){${fields.join(' ')}}`;
  const request = () => fetch('https://graphql.anilist.co', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query: batchQuery, variables }), signal: AbortSignal.timeout(15_000) });
  lastRequest = Date.now();
  let response = await request();
  if (response.status === 429) {
    const retryAfter = Number(response.headers.get('retry-after'));
    await pause(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 5000);
    lastRequest = Date.now(); response = await request();
  }
  if (!response.ok) throw new Error(`AniList batch search returned HTTP ${response.status}`);
  const payload = await response.json() as { data?: Record<string, { media?: AniListMedia[] }> };
  return new Map(terms.map((term, index) => [term, payload.data?.[`p${index}`]?.media ?? []]));
}
function seasonNumber(media: AniListMedia): number | null {
  const names = namesOf(media).map(normalize);
  for (const name of names) {
    const match = name.match(/(?:season|series)\s+(\d{1,2})|\b(\d{1,2})(?:st|nd|rd|th)\s+season\b|第\s*(\d{1,2})\s*期|\s(\d{1,2})$|\s(ii|iii)$/);
    if (match) return Number(match[1] ?? match[2] ?? match[3] ?? match[4] ?? (match[5] === 'ii' ? 2 : match[5] === 'iii' ? 3 : 0)) || null;
  }
  return null;
}
function seasonBase(value: string): string {
  return normalize(value).replace(/\b(?:season|series)\s+\d{1,2}\b|\b\d{1,2}(?:st|nd|rd|th)\s+season\b|第\s*\d{1,2}\s*期\b|\s\d{1,2}$|\s(?:ii|iii)$/g, '').replace(/\s+/g, ' ').trim();
}
function candidateScore(media: AniListMedia, title: string, season: number | null): number {
  const names = namesOf(media);
  const lexical = Math.max(...names.map(name => scoreTelegramTitle([name], title).score), 0);
  if (season === null || season <= 1) return lexical;
  if (!['TV', 'ONA'].includes(media.format ?? '')) return 0;
  const declaredSeason = seasonNumber(media);
  if (declaredSeason !== season) return 0;
  const base = seasonBase(title);
  const matchingBase = names.some(name => seasonBase(name) === base || seasonBase(name).startsWith(`${base} `));
  // DECISION: Komi's second season uses a translated English title; bridge it only to the verified AniList entry.
  if (media.id === 142984 && /^komi san wa comyushou desu$/i.test(base)) return 0.96;
  return matchingBase ? Math.max(lexical, 0.96) : 0;
}

const grouped = new Map<string, { names: Set<string>; messages: Message[]; season: number | null }>();
for (const message of messages) {
  const parsed = parseTelegramMedia(message.filename, message.caption, message.duration_seconds);
  if (parsed.compilation || parsed.episode === null || !parsed.titleNames.length) continue;
  for (const name of parsed.titleNames) {
    const key = `${keyOf(name)}\u0000${parsed.season ?? 0}`;
    const group = grouped.get(key) ?? { names: new Set<string>(), messages: [], season: parsed.season };
    group.names.add(name);
    group.messages.push(message);
    grouped.set(key, group);
  }
}

const existingRows = db.prepare('SELECT id,romaji,english,native,title_bg FROM titles').all() as Array<{ id: number; romaji: string | null; english: string | null; native: string | null; title_bg: string | null }>;
const dbTitle = (row: typeof existingRows[number]): AniListMedia => ({ id: row.id, siteUrl: `https://anilist.co/anime/${row.id}`, title: { romaji: row.romaji, english: row.english, native: row.native } });
const titleMappings = new Map<string, { media: AniListMedia; alias: string; score: number }>();
const pending = new Map<string, { aliases: string[]; season: number | null; terms: string[] }>();
for (const [key, group] of grouped) {
  const aliases = [...group.names];
  const local = existingRows.map(row => ({ media: dbTitle(row), score: Math.max(...[row.romaji, row.english, row.native, row.title_bg].filter((x): x is string => Boolean(x)).map(name => scoreTelegramTitle([name], aliases[0]!).score)) })).sort((a, b) => b.score - a.score)[0];
  if (local && local.score >= 0.92 && (group.season === null || group.season <= 1)) {
    titleMappings.set(key, { media: local.media, alias: aliases[0]!, score: local.score });
    continue;
  }
  const searchTerms = new Set<string>();
  for (const alias of aliases) {
    searchTerms.add(alias);
    if (/yonkyoudai/i.test(alias)) searchTerms.add(alias.replace(/yonkyoudai/ig, 'Yon Kyoudai'));
    if (group.season && group.season > 1) {
      searchTerms.add(`${alias} season ${group.season}`);
      searchTerms.add(`${alias} ${group.season}${group.season === 2 ? 'nd' : group.season === 3 ? 'rd' : 'th'} season`);
      if (normalize(alias).replace(/[^a-z0-9]+/g, ' ').trim() === 'komi san wa comyushou desu' && group.season === 2) {
        searchTerms.add("Komi Can't Communicate Season 2");
      }
    }
  }
  pending.set(key, { aliases, season: group.season, terms: [...searchTerms] });
}
const resultByTerm = new Map<string, AniListMedia[]>();
const terms = [...new Set([...pending.values()].flatMap(item => item.terms))];
for (let index = 0; index < terms.length; index += 8) {
  const batch = terms.slice(index, index + 8);
  try {
    const results = await searchAniListBatch(batch);
    for (const [term, media] of results) resultByTerm.set(term, media);
  } catch (error) {
    console.error(`AniList batch ${index + 1}-${index + batch.length} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  console.info(JSON.stringify({ aniListTermsQueried: Math.min(index + batch.length, terms.length), totalTerms: terms.length }));
}
for (const [key, item] of pending) {
  const { aliases, season } = item;
  const results = new Map<number, AniListMedia>();
  for (const term of item.terms) for (const media of resultByTerm.get(term) ?? []) results.set(media.id, media);
  const ranked = [...results.values()].map(media => ({ media, score: Math.max(...aliases.map(alias => candidateScore(media, alias, season))) })).sort((a, b) => b.score - a.score);
  const winner = ranked[0];
  if (!winner || winner.score < 0.88 || (ranked[1]?.score ?? 0) >= winner.score - 0.01) {
    console.info(JSON.stringify({ state: 'review', aliases, season, candidates: ranked.slice(0, 3).map(item => ({ id: item.media.id, title: item.media.title, score: item.score })) }));
    continue;
  }
  titleMappings.set(key, { media: winner.media, alias: aliases[0]!, score: winner.score });
}

const imported = new Set<number>();
const tx = db.transaction(() => {
  for (const [key, mapping] of titleMappings) {
    const media = mapping.media;
    const site = new URL(media.siteUrl);
    const slug = site.pathname.split('/').filter(Boolean).at(-1);
    if (!slug) continue;
    insertTitle.run({ id: media.id, slug, romaji: media.title.romaji, english: media.title.english, native: media.title.native,
      year: media.seasonYear ?? null, format: media.format ?? null, episodes: media.episodes ?? null, cover: media.coverImage?.extraLarge ?? null,
      banner: media.bannerImage ?? null, status: media.status ?? null, score: media.averageScore == null ? null : media.averageScore / 10,
      season: media.season ?? null, genres: JSON.stringify(media.genres ?? []), tags: JSON.stringify(media.tags?.map(tag => tag.name) ?? []) });
    if (!media.episodes) {
      const max = Math.max(1, ...messages.map(message => parseTelegramMedia(message.filename, message.caption, message.duration_seconds)).filter(parsed => parsed.titleNames.some(name => normalize(name) === normalize(mapping.alias))).map(parsed => parsed.episode ?? 1));
      for (let episode = 1; episode <= max; episode++) insertEpisode.run(media.id, episode);
    } else for (let episode = 1; episode <= media.episodes; episode++) insertEpisode.run(media.id, episode);
    if (!existingRows.some(row => row.id === media.id)) imported.add(media.id);
  }
});
tx();

for (const message of messages) {
  const parsed = parseTelegramMedia(message.filename, message.caption, message.duration_seconds);
  if (parsed.compilation || parsed.episode === null) continue;
  for (const alias of parsed.titleNames) {
    const mapping = titleMappings.get(`${keyOf(alias)}\u0000${parsed.season ?? 0}`);
    if (mapping) upsertTelegramAlias(mapping.media.id, alias);
  }
}

db.close();
console.info(JSON.stringify({ episodesSeen: messages.length, confidentTitleMappings: titleMappings.size, titlesImported: [...imported], episodeRowsUpdatedByRematch: 'run npm run telegram:rematch now' }));
