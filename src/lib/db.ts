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
export interface BulgarianCoverage { available: number; total: number; complete: boolean; }
const existingTables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(row => row.name));
const tableExists = (name: string) => existingTables.has(name);
export function getBulgarianCoverage(titleId: number): BulgarianCoverage {
  const hasArtifacts = tableExists('subtitle_artifacts');
  const hasIndex = tableExists('subtitle_index') && tableExists('subtitle_assets');
  const hasTelegram = tableExists('telegram_episode_matches');
  const clauses = ["EXISTS(SELECT 1 FROM subs s WHERE s.title_id=e.title_id AND s.number=e.number AND s.status IN ('qc','final') AND s.path IS NOT NULL AND s.path<>'')"];
  if (hasArtifacts) clauses.push("EXISTS(SELECT 1 FROM subtitle_artifacts a WHERE CAST(a.anime_id AS INTEGER)=e.title_id AND CAST(a.episode_id AS INTEGER)=e.number AND a.target_language='bg' AND a.validation_status='validated')");
  if (hasIndex) clauses.push("EXISTS(SELECT 1 FROM subtitle_index i JOIN subtitle_assets sa ON sa.content_hash=i.asset_hash LEFT JOIN subtitle_index_verification_queue q ON q.index_id=i.id WHERE CAST(i.anime_id AS INTEGER)=e.title_id AND i.episode_number=e.number AND lower(i.language)='bg' AND i.catalog_only=0 AND i.fetchable=1 AND i.asset_hash IS NOT NULL AND i.verified=1 AND (i.quality_score>=0.85 OR q.state='VERIFIED'))");
  if (hasTelegram) clauses.push("EXISTS(SELECT 1 FROM telegram_episode_matches x WHERE x.anime_id=e.title_id AND x.episode_number=e.number AND x.status='MATCHED' AND x.verified=1 AND x.primary_match=1 AND x.hardsub_language='bg')");
  const row = db.prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN ${clauses.join(' OR ')} THEN 1 ELSE 0 END) AS available FROM episodes e WHERE e.title_id=?`).get(titleId) as { total: number; available: number | null };
  const total = Number(row.total);
  const available = Number(row.available ?? 0);
  return { total, available, complete: total > 0 && available >= total };
}
export function getAllWatchData() {
  const rows = db.prepare(`SELECT t.slug,t.id,t.romaji,t.english,t.native,t.title_bg,t.synopsis_bg,t.year,t.format,t.episodes,t.cover,t.banner,t.status,t.score,t.season,t.genres,t.tags,e.number,s.path AS sub_path,s.status AS sub_status,s.source AS sub_source,
    EXISTS(SELECT 1 FROM telegram_episode_matches tx WHERE tx.anime_id=t.id AND tx.episode_number=e.number AND tx.status='MATCHED' AND tx.verified=1 AND tx.primary_match=1) AS telegram_hardsub
    FROM titles t JOIN episodes e ON e.title_id=t.id LEFT JOIN subs s ON s.title_id=t.id AND s.number=e.number ORDER BY t.id,e.number`).all() as Array<TitleRow & { number: number; sub_path: string | null; sub_status: string | null; sub_source: string | null; telegram_hardsub: number }>;
  return rows.map(row => ({ ...decodeTitle(row), number: row.number, sub_path: row.sub_path, sub_status: row.sub_status, sub_source: row.sub_source }));
}
