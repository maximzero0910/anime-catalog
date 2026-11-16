import Database from 'better-sqlite3';
import { readFile, writeFile } from 'node:fs/promises';

const dbPath = new URL('../data/catalog.db', import.meta.url);
const ids = JSON.parse(await readFile(new URL('../data/fixtures.json', import.meta.url), 'utf8')) as number[];
const db = new Database(dbPath.pathname);
db.pragma('foreign_keys = ON');
const catalogExists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='titles'").get();
if (!catalogExists) db.exec(`
CREATE TABLE titles(
  id INTEGER PRIMARY KEY, slug TEXT UNIQUE NOT NULL,
  romaji TEXT, english TEXT, native TEXT,
  title_bg TEXT, synopsis_bg TEXT, year INTEGER, format TEXT,
  episodes INTEGER, cover TEXT, banner TEXT, status TEXT, score REAL,
  season TEXT, genres TEXT NOT NULL DEFAULT '[]', tags TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE episodes(
  title_id INTEGER NOT NULL REFERENCES titles(id),
  number INTEGER NOT NULL, duration INTEGER, filler INTEGER DEFAULT 0,
  PRIMARY KEY (title_id, number)
);
CREATE TABLE streams(
  title_id INTEGER NOT NULL, number INTEGER NOT NULL, quality TEXT,
  m3u8 TEXT, referer TEXT, source TEXT, resolved_at INTEGER
);
CREATE TABLE subs(
  title_id INTEGER NOT NULL, number INTEGER NOT NULL, path TEXT,
  source TEXT, status TEXT DEFAULT 'draft', translator TEXT,
  PRIMARY KEY (title_id, number)
);
`);
const columns = new Set((db.pragma('table_info(titles)') as Array<{ name: string }>).map(column => column.name));
if (!columns.has('genres')) db.exec("ALTER TABLE titles ADD COLUMN genres TEXT NOT NULL DEFAULT '[]'");
if (!columns.has('tags')) db.exec("ALTER TABLE titles ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'");
const query = `query ($id: Int) { Media(id: $id, type: ANIME) { id siteUrl title { romaji english native } coverImage { extraLarge } bannerImage episodes format seasonYear averageScore status season genres tags { name category } description(asHtml: false) } }`;
const insertTitle = db.prepare(`INSERT OR REPLACE INTO titles(id,slug,romaji,english,native,title_bg,synopsis_bg,year,format,episodes,cover,banner,status,score,season,genres,tags) VALUES (@id,@slug,@romaji,@english,@native,NULL,NULL,@year,@format,@episodes,@cover,@banner,@status,@score,@season,@genres,@tags)`);
const clearEpisodes = db.prepare('DELETE FROM episodes WHERE title_id = ?');
const insertEpisode = db.prepare('INSERT OR REPLACE INTO episodes(title_id,number,filler) VALUES (?,?,0)');
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
let lastRequest = 0;
const descriptions: Record<string, string | null> = {};
for (const id of ids) {
  await delay(Math.max(0, 700 - (Date.now() - lastRequest)));
  let response: Response | undefined;
  for (let attempt = 0; attempt <= 2; attempt++) {
    lastRequest = Date.now();
    response = await fetch('https://graphql.anilist.co', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query, variables: { id } }),
    });
    if (response.status !== 429 || attempt === 2) break;
    await delay(900 * (attempt + 1));
  }
  if (!response?.ok) throw new Error(`AniList request failed for ${id}: ${response?.status}`);
  const payload = await response.json() as { data?: { Media?: AniMedia } };
  const media = payload.data?.Media;
  if (!media) throw new Error(`AniList returned no anime for ${id}`);
  descriptions[String(id)] = media.description ?? null;
  const slug = new URL(media.siteUrl).pathname.split('/').filter(Boolean).at(-1);
  if (!slug) throw new Error(`Could not resolve slug for ${id}`);
  const episodeCount = media.episodes ?? 0;
  clearEpisodes.run(id);
  insertTitle.run({ id, slug, romaji: media.title.romaji, english: media.title.english, native: media.title.native,
    year: media.seasonYear, format: media.format, episodes: episodeCount, cover: media.coverImage?.extraLarge,
    banner: media.bannerImage, status: media.status, score: media.averageScore == null ? null : media.averageScore / 10,
    season: media.season, genres: JSON.stringify(media.genres ?? []), tags: JSON.stringify(media.tags?.map(tag => tag.name) ?? []) });
  const insertAll = db.transaction(() => { for (let n = 1; n <= episodeCount; n++) insertEpisode.run(id, n); });
  insertAll();
  console.log(`Imported ${id} as ${slug} (${episodeCount} episodes)`);
}
db.close();
await writeFile(new URL('../data/descriptions.json', import.meta.url), JSON.stringify(descriptions, null, 2) + '\n');

interface AniMedia {
  id: number; siteUrl: string; title: { romaji: string | null; english: string | null; native: string | null };
  coverImage?: { extraLarge?: string }; bannerImage?: string | null; episodes?: number | null;
  format?: string | null; seasonYear?: number | null; averageScore?: number | null; status?: string | null;
  season?: string | null; description?: string | null; genres?: string[]; tags?: Array<{ name: string; category: string }>;
}
