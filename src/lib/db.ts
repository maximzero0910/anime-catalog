import Database from 'better-sqlite3';
import { resolve } from 'node:path';

const db = new Database(resolve(process.cwd(), 'data/catalog.db'), { readonly: true, fileMustExist: true });
export interface Title {
  id: number; slug: string; romaji: string | null; english: string | null; native: string | null;
  title_bg: string | null; synopsis_bg: string | null; year: number | null; format: string | null;
  episodes: number | null; cover: string | null; banner: string | null; status: string | null; score: number | null; season: string | null;
}
export interface Episode { title_id: number; number: number; duration: number | null; filler: number; }
export interface Subtitle { title_id: number; number: number; path: string | null; source: string | null; status: string; translator: string | null; }
export function getTitles(): Title[] { return db.prepare('SELECT * FROM titles ORDER BY score DESC, id').all() as Title[]; }
export function getTitle(slug: string): Title | undefined { return db.prepare('SELECT * FROM titles WHERE slug = ?').get(slug) as Title | undefined; }
export function getTitleById(id: number): Title | undefined { return db.prepare('SELECT * FROM titles WHERE id = ?').get(id) as Title | undefined; }
export function getEpisodes(titleId: number): Episode[] { return db.prepare('SELECT * FROM episodes WHERE title_id = ? ORDER BY number').all(titleId) as Episode[]; }
export function getSubtitle(titleId: number, number: number): Subtitle | undefined { return db.prepare('SELECT * FROM subs WHERE title_id = ? AND number = ?').get(titleId, number) as Subtitle | undefined; }
export function getAllWatchData() {
  return db.prepare(`SELECT t.slug,t.id,t.romaji,t.english,t.native,t.title_bg,t.synopsis_bg,t.year,t.format,t.episodes,t.cover,t.banner,t.status,t.score,t.season,e.number,s.path AS sub_path,s.status AS sub_status,s.source AS sub_source FROM titles t JOIN episodes e ON e.title_id=t.id LEFT JOIN subs s ON s.title_id=t.id AND s.number=e.number ORDER BY t.id,e.number`).all() as Array<Title & { number: number; sub_path: string | null; sub_status: string | null; sub_source: string | null }>;
}
