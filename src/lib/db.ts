import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import './telegram/storage';

const db = new Database(resolve(process.cwd(), 'data/catalog.db'), { readonly: true, fileMustExist: true });
export interface Title {
  id: number; slug: string; romaji: string | null; english: string | null; native: string | null;
  title_bg: string | null; synopsis_bg: string | null; year: number | null; format: string | null;
  episodes: number | null; cover: string | null; banner: string | null; status: string | null; score: number | null; season: string | null;
  genres: string[]; tags: string[];
}
export interface Episode { title_id: number; number: number; duration: number | null; filler: number; }
export interface Subtitle { title_id: number; number: number; path: string | null; source: string | null; status: string; translator: string | null; }
type TitleRow = Omit<Title, 'genres' | 'tags'> & { genres: string; tags: string };
function decodeTitle(row: TitleRow): Title {
  return { ...row, genres: JSON.parse(row.genres || '[]') as string[], tags: JSON.parse(row.tags || '[]') as string[] };
}
export function getTitles(): Title[] { return (db.prepare('SELECT * FROM titles ORDER BY score DESC, id').all() as TitleRow[]).map(decodeTitle); }
export function getTitle(slug: string): Title | undefined {
  const row = db.prepare('SELECT * FROM titles WHERE slug = ?').get(slug) as TitleRow | undefined;
  return row && decodeTitle(row);
}
export function getTitleById(id: number): Title | undefined {
  const row = db.prepare('SELECT * FROM titles WHERE id = ?').get(id) as TitleRow | undefined;
  return row && decodeTitle(row);
}
export function getEpisodes(titleId: number): Episode[] { return db.prepare('SELECT * FROM episodes WHERE title_id = ? ORDER BY number').all(titleId) as Episode[]; }
export function getSubtitle(titleId: number, number: number): Subtitle | undefined { return db.prepare('SELECT * FROM subs WHERE title_id = ? AND number = ?').get(titleId, number) as Subtitle | undefined; }
export function getAllWatchData() {
  const rows = db.prepare(`SELECT t.slug,t.id,t.romaji,t.english,t.native,t.title_bg,t.synopsis_bg,t.year,t.format,t.episodes,t.cover,t.banner,t.status,t.score,t.season,t.genres,t.tags,e.number,s.path AS sub_path,s.status AS sub_status,s.source AS sub_source,
    EXISTS(SELECT 1 FROM telegram_episode_matches tx WHERE tx.anime_id=t.id AND tx.episode_number=e.number AND tx.status='MATCHED' AND tx.verified=1 AND tx.primary_match=1) AS telegram_hardsub
    FROM titles t JOIN episodes e ON e.title_id=t.id LEFT JOIN subs s ON s.title_id=t.id AND s.number=e.number ORDER BY t.id,e.number`).all() as Array<TitleRow & { number: number; sub_path: string | null; sub_status: string | null; sub_source: string | null; telegram_hardsub: number }>;
  return rows.map(row => ({ ...decodeTitle(row), number: row.number, sub_path: row.sub_path, sub_status: row.sub_status, sub_source: row.sub_source }));
}
