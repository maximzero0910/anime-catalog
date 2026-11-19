import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { subtitleConfig } from './config';
import { catalogDatabasePath } from '../catalog-path';
import { scoreTitleMatch } from './match';

export type JobState = 'DISCOVERED' | 'QUEUED' | 'DOWNLOADING' | 'NORMALIZING' | 'TRANSLATING' | 'VALIDATING' | 'COMPLETED' | 'FAILED' | 'SKIPPED';
const dbPath = catalogDatabasePath();
const bodyRoot = resolve(subtitleConfig.dataDirectory);
const database = new Database(dbPath, { timeout: 5000 });
database.pragma('journal_mode = WAL');
database.pragma('foreign_keys = ON');
database.pragma('busy_timeout = 5000');
database.exec(`
CREATE TABLE IF NOT EXISTS subtitle_artifacts (
  id INTEGER PRIMARY KEY, anime_id INTEGER NOT NULL, season_id TEXT, episode_id TEXT NOT NULL,
  source_language TEXT NOT NULL, target_language TEXT NOT NULL, source_hash TEXT NOT NULL,
  model TEXT NOT NULL, translation_version TEXT NOT NULL, config_hash TEXT NOT NULL, created_at TEXT NOT NULL,
  validation_status TEXT NOT NULL CHECK(validation_status IN ('validated','rejected')),
  source_format TEXT NOT NULL, translated_format TEXT NOT NULL,
  source_path TEXT NOT NULL, translated_path TEXT NOT NULL, score REAL NOT NULL,
  UNIQUE(anime_id, episode_id, source_hash, target_language, config_hash)
);
CREATE INDEX IF NOT EXISTS subtitle_artifacts_lookup ON subtitle_artifacts(anime_id,episode_id,target_language,validation_status);
CREATE TABLE IF NOT EXISTS subtitle_jobs (
  id INTEGER PRIMARY KEY, anime_id INTEGER NOT NULL, season_id TEXT, episode_id TEXT NOT NULL,
  target_language TEXT NOT NULL DEFAULT 'bg', source_language TEXT, provider_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('DISCOVERED','QUEUED','DOWNLOADING','NORMALIZING','TRANSLATING','VALIDATING','COMPLETED','FAILED','SKIPPED')),
  attempts INTEGER NOT NULL DEFAULT 0, available_at INTEGER NOT NULL DEFAULT 0, locked_at INTEGER,
  checkpoint TEXT NOT NULL DEFAULT '{}', error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  source_hash TEXT, UNIQUE(anime_id,episode_id,target_language)
);
CREATE INDEX IF NOT EXISTS subtitle_jobs_ready ON subtitle_jobs(status,available_at,anime_id,episode_id);
CREATE TABLE IF NOT EXISTS subtitle_glossary (
  anime_id INTEGER NOT NULL, source TEXT NOT NULL, target TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(anime_id,source)
);
CREATE TABLE IF NOT EXISTS subtitle_job_logs (
  id INTEGER PRIMARY KEY, job_id INTEGER NOT NULL REFERENCES subtitle_jobs(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL, level TEXT NOT NULL, event TEXT NOT NULL, details TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS subtitle_job_logs_job ON subtitle_job_logs(job_id,created_at);
CREATE TABLE IF NOT EXISTS subtitle_worker_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS subtitle_dead_letters (id INTEGER PRIMARY KEY, job_id INTEGER NOT NULL UNIQUE REFERENCES subtitle_jobs(id), failed_at TEXT NOT NULL, attempts INTEGER NOT NULL, reason TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS subtitle_assets (
  content_hash TEXT PRIMARY KEY, format TEXT NOT NULL, language TEXT NOT NULL, storage_path TEXT NOT NULL,
  byte_length INTEGER NOT NULL, provenance TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS subtitle_index (
  id INTEGER PRIMARY KEY, anime_id TEXT NOT NULL, anidb_id TEXT, imdb_id TEXT, season_number INTEGER,
  episode_number INTEGER NOT NULL, language TEXT NOT NULL, provider TEXT NOT NULL, provider_id TEXT NOT NULL,
  release_group TEXT, file_hash TEXT, duration_ms INTEGER, format TEXT, source_url TEXT, attribution TEXT,
  quality_score REAL NOT NULL DEFAULT 0, verified INTEGER NOT NULL DEFAULT 0, catalog_only INTEGER NOT NULL DEFAULT 0,
  fetchable INTEGER NOT NULL DEFAULT 0, asset_hash TEXT REFERENCES subtitle_assets(content_hash), discovered_at TEXT NOT NULL,
  UNIQUE(provider,provider_id)
);
CREATE INDEX IF NOT EXISTS subtitle_index_lookup ON subtitle_index(anime_id,episode_number,language,quality_score DESC);
CREATE INDEX IF NOT EXISTS subtitle_index_alias_lookup ON subtitle_index(provider,anime_id,language,episode_number);
CREATE TABLE IF NOT EXISTS subtitle_index_verification_queue (
  index_id INTEGER PRIMARY KEY REFERENCES subtitle_index(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'QUEUED' CHECK(state IN ('QUEUED','RUNNING','VERIFIED','REJECTED')),
  reason TEXT NOT NULL, queued_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS subtitle_asset_sources (
  content_hash TEXT NOT NULL REFERENCES subtitle_assets(content_hash), provider TEXT NOT NULL,
  provider_id TEXT NOT NULL, source_url TEXT, attribution TEXT, added_at TEXT NOT NULL,
  PRIMARY KEY(content_hash,provider,provider_id)
);
CREATE TABLE IF NOT EXISTS subtitle_title_aliases (
  anime_id TEXT NOT NULL, normalized_title TEXT NOT NULL, display_title TEXT NOT NULL,
  PRIMARY KEY(anime_id,normalized_title)
);
CREATE INDEX IF NOT EXISTS subtitle_title_alias_lookup ON subtitle_title_aliases(normalized_title,anime_id);
CREATE TABLE IF NOT EXISTS title_alias (
  anilist_id TEXT NOT NULL, source_id TEXT NOT NULL, source_title TEXT NOT NULL,
  normalized_title TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(anilist_id,source_id,normalized_title)
);
CREATE INDEX IF NOT EXISTS title_alias_lookup ON title_alias(anilist_id,source_id);
CREATE TABLE IF NOT EXISTS needs_mapping (
  id INTEGER PRIMARY KEY, anilist_id TEXT NOT NULL, episode_number INTEGER NOT NULL,
  source_id TEXT NOT NULL, source_title TEXT NOT NULL, candidate_url TEXT,
  score REAL NOT NULL, state TEXT NOT NULL DEFAULT 'NEEDS_MAPPING' CHECK(state IN ('NEEDS_MAPPING','MAPPED','REJECTED')),
  reason TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(anilist_id,episode_number,source_id,source_title,candidate_url)
);
CREATE INDEX IF NOT EXISTS needs_mapping_queue ON needs_mapping(state,created_at);
CREATE TABLE IF NOT EXISTS subtitle_hardsubs (
  anilist_id TEXT NOT NULL, episode_number INTEGER NOT NULL, source_id TEXT NOT NULL,
  source_title TEXT NOT NULL, source_url TEXT, created_at TEXT NOT NULL,
  PRIMARY KEY(anilist_id,episode_number,source_id)
);
CREATE TABLE IF NOT EXISTS subtitle_offsets (
  anime_id INTEGER NOT NULL, episode INTEGER NOT NULL, source_id TEXT NOT NULL,
  offset_ms INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL,
  PRIMARY KEY(anime_id,episode,source_id)
);
CREATE TABLE IF NOT EXISTS subtitle_provider_misses (
  anime_id TEXT NOT NULL, episode_number INTEGER NOT NULL, provider TEXT NOT NULL, expires_at INTEGER NOT NULL,
  PRIMARY KEY(anime_id,episode_number,provider)
);
CREATE TABLE IF NOT EXISTS subtitle_provider_http_cache (
  cache_key TEXT PRIMARY KEY, etag TEXT, last_modified TEXT, response_body TEXT, response_status INTEGER,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS subtitle_index_jobs (
  id INTEGER PRIMARY KEY, anime_id TEXT NOT NULL, episode_number INTEGER NOT NULL,
  season_number INTEGER, video_hash TEXT, release_group TEXT, duration_ms INTEGER,
  state TEXT NOT NULL DEFAULT 'QUEUED' CHECK(state IN ('QUEUED','RUNNING','COMPLETED','FAILED')),
  attempts INTEGER NOT NULL DEFAULT 0, available_at INTEGER NOT NULL DEFAULT 0, locked_at INTEGER,
  error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(anime_id,episode_number)
);
CREATE INDEX IF NOT EXISTS subtitle_index_jobs_ready ON subtitle_index_jobs(state,available_at,anime_id,episode_number);
CREATE TABLE IF NOT EXISTS subtitle_indexer_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS anime_popularity (
  anilist_id INTEGER PRIMARY KEY, anime_id INTEGER, title TEXT NOT NULL, romaji TEXT, english TEXT, native TEXT,
  synonyms TEXT NOT NULL DEFAULT '[]', popularity INTEGER NOT NULL DEFAULT 0, rank INTEGER NOT NULL,
  format TEXT, season_year INTEGER, synced_at TEXT NOT NULL, match_score REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS subtitle_priority_overrides (
  anilist_id INTEGER NOT NULL, season_label TEXT NOT NULL DEFAULT '', priority REAL NOT NULL,
  reason TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(anilist_id,season_label)
);
`);

const subtitleJobColumns = new Set((database.pragma('table_info(subtitle_jobs)') as Array<{ name: string }>).map(column => column.name));
if (!subtitleJobColumns.has('priority')) database.exec('ALTER TABLE subtitle_jobs ADD COLUMN priority REAL NOT NULL DEFAULT 0');
if (!subtitleJobColumns.has('worker_id')) database.exec('ALTER TABLE subtitle_jobs ADD COLUMN worker_id TEXT');
if (!subtitleJobColumns.has('lease_expires_at')) database.exec('ALTER TABLE subtitle_jobs ADD COLUMN lease_expires_at INTEGER');
database.exec('CREATE INDEX IF NOT EXISTS subtitle_jobs_priority_ready ON subtitle_jobs(status,available_at,priority DESC,anime_id,episode_id)');

export interface Job { id: number; anime_id: number; season_id: string | null; episode_id: string; target_language: string; source_language: string | null; provider_id: string | null; status: JobState; attempts: number; available_at: number; locked_at: number | null; checkpoint: Record<string, unknown>; error: string | null; source_hash: string | null; updated_at: string; priority: number; worker_id?: string | null; lease_expires_at?: number | null; }
const fromRow = (row: Record<string, unknown>): Job => ({ ...row, checkpoint: JSON.parse(String(row.checkpoint ?? '{}')) } as Job);
const nowIso = () => new Date().toISOString();

// DECISION: Seed only observed labels for the verified test title; all other title fixes remain operator-managed aliases.
database.prepare(`INSERT OR IGNORE INTO title_alias(anilist_id,source_id,source_title,normalized_title,created_at) VALUES(?,?,?,?,?)`).run('142853', 'anikoto', 'Tokyo Revengers: Christmas Showdown', normalizeAlias('Tokyo Revengers: Christmas Showdown'), nowIso());
database.prepare(`INSERT OR IGNORE INTO title_alias(anilist_id,source_id,source_title,normalized_title,created_at) VALUES(?,?,?,?,?)`).run('142853', 'anima-pr', 'Tokyo Revengers S1-2', normalizeAlias('Tokyo Revengers S1-2'), nowIso());
database.prepare(`INSERT OR IGNORE INTO title_alias(anilist_id,source_id,source_title,normalized_title,created_at) VALUES(?,?,?,?,?)`).run('142853', 'playtube', 'Токийски отмъстители', normalizeAlias('Токийски отмъстители'), nowIso());
// DECISION: AniList 178083 is the verified Tokyo Revengers S4 entry; keep its operator priority ahead of popularity tiers.
database.prepare(`INSERT OR IGNORE INTO subtitle_priority_overrides(anilist_id,season_label,priority,reason,updated_at) VALUES(?,?,?,?,?)`).run(178083, '', 99999, 'Tokyo Revengers S4 operator priority', nowIso());

function normalizeAlias(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export interface TitleAlias { anilist_id: string; source_id: string; source_title: string; normalized_title: string; }
export function subtitleTitleAliases(anilistId: number | string, sourceId?: string): TitleAlias[] {
  return sourceId
    ? database.prepare('SELECT anilist_id,source_id,source_title,normalized_title FROM title_alias WHERE anilist_id=? AND source_id=? ORDER BY source_title').all(String(anilistId), sourceId) as TitleAlias[]
    : database.prepare('SELECT anilist_id,source_id,source_title,normalized_title FROM title_alias WHERE anilist_id=? ORDER BY source_id,source_title').all(String(anilistId)) as TitleAlias[];
}
export function addSubtitleTitleAlias(anilistId: number | string, sourceId: string, sourceTitle: string): void {
  const title = sourceTitle.trim();
  if (!/^\d{1,12}$/.test(String(anilistId)) || !/^[a-z0-9][a-z0-9-]{0,63}$/i.test(sourceId) || !title || title.length > 240) throw new Error('invalid title alias');
  database.prepare('INSERT OR IGNORE INTO title_alias(anilist_id,source_id,source_title,normalized_title,created_at) VALUES(?,?,?,?,?)').run(String(anilistId), sourceId.toLowerCase(), title, normalizeAlias(title), nowIso());
}
export function queueNeedsMapping(input: { animeId: number | string; episode: number; sourceId: string; sourceTitle: string; candidateUrl?: string | null; score: number; reason: string }): void {
  database.prepare(`INSERT INTO needs_mapping(anilist_id,episode_number,source_id,source_title,candidate_url,score,reason,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(anilist_id,episode_number,source_id,source_title,candidate_url) DO UPDATE SET score=excluded.score,reason=excluded.reason,updated_at=excluded.updated_at WHERE needs_mapping.state='NEEDS_MAPPING'`).run(String(input.animeId), input.episode, input.sourceId, input.sourceTitle.slice(0, 240), input.candidateUrl ?? null, input.score, input.reason.slice(0, 500), nowIso(), nowIso());
}
export function pendingSubtitleMappings(limit = 100): Array<Record<string, unknown>> {
  return database.prepare("SELECT * FROM needs_mapping WHERE state='NEEDS_MAPPING' ORDER BY created_at,id LIMIT ?").all(Math.max(1, Math.min(500, limit))) as Array<Record<string, unknown>>;
}
export function resolveSubtitleMapping(id: number, action: 'map' | 'reject'): void {
  const row = database.prepare("SELECT * FROM needs_mapping WHERE id=? AND state='NEEDS_MAPPING'").get(id) as { anilist_id: string; source_id: string; source_title: string } | undefined;
  if (!row) throw new Error('mapping candidate not found');
  if (action === 'map') addSubtitleTitleAlias(row.anilist_id, row.source_id, row.source_title);
  database.prepare('UPDATE needs_mapping SET state=?,updated_at=? WHERE id=?').run(action === 'map' ? 'MAPPED' : 'REJECTED', nowIso(), id);
}
export function saveSubtitleHardsub(input: { animeId: number | string; episode: number; sourceId: string; sourceTitle: string; sourceUrl?: string | null }): void {
  database.prepare('INSERT INTO subtitle_hardsubs(anilist_id,episode_number,source_id,source_title,source_url,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(anilist_id,episode_number,source_id) DO UPDATE SET source_title=excluded.source_title,source_url=excluded.source_url').run(String(input.animeId), input.episode, input.sourceId, input.sourceTitle.slice(0, 240), input.sourceUrl ?? null, nowIso());
}
export function getSubtitleHardsub(animeId: number | string, episode: number): { source_id: string; source_title: string; source_url: string | null } | undefined {
  return database.prepare('SELECT source_id,source_title,source_url FROM subtitle_hardsubs WHERE anilist_id=? AND episode_number=? ORDER BY created_at DESC LIMIT 1').get(String(animeId), episode) as { source_id: string; source_title: string; source_url: string | null } | undefined;
}
export function getSubtitleOffset(animeId: number, episode: number, sourceId: string): number {
  const row = database.prepare('SELECT offset_ms FROM subtitle_offsets WHERE anime_id=? AND episode=? AND source_id=?').get(animeId, episode, sourceId) as { offset_ms: number } | undefined;
  return row?.offset_ms ?? 0;
}
export function subtitleOffsets(animeId: number, episode: number): Record<string, number> {
  const rows = database.prepare('SELECT source_id,offset_ms FROM subtitle_offsets WHERE anime_id=? AND episode=? ORDER BY source_id').all(animeId, episode) as Array<{ source_id: string; offset_ms: number }>;
  return Object.fromEntries(rows.map(row => [row.source_id, row.offset_ms]));
}
export function setSubtitleOffset(animeId: number, episode: number, sourceId: string, offsetMs: number): void {
  database.prepare('INSERT INTO subtitle_offsets(anime_id,episode,source_id,offset_ms,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(anime_id,episode,source_id) DO UPDATE SET offset_ms=excluded.offset_ms,updated_at=excluded.updated_at').run(animeId, episode, sourceId, Math.max(-120_000, Math.min(120_000, Math.trunc(offsetMs))), nowIso());
}
export function skipJobForNoSubtitleSource(jobId: number, reason = 'no subtitle source', rediscoverAfterMs = 7 * 24 * 60 * 60_000): void {
  updateJob(jobId, 'SKIPPED', { error: reason, lockedAt: null, availableAt: Date.now() + Math.max(60_000, rediscoverAfterMs) });
  logJob(jobId, 'info', 'subtitle_discovery_skipped', { reason });
}

export interface SubtitleIndexInput {
  animeId: string; anidbId?: string | null; imdbId?: string | null; seasonNumber?: number | null;
  episodeNumber: number; language: string; provider: string; providerId: string;
  releaseGroup?: string | null; fileHash?: string | null; durationMs?: number | null;
  format?: string | null; sourceUrl?: string | null; attribution?: string | null;
  qualityScore: number; verified?: boolean; catalogOnly?: boolean; fetchable?: boolean; assetHash?: string | null;
}

export interface SubtitleIndexRecord extends SubtitleIndexInput { id: number; discovered_at: string; }

export async function storeSubtitleAsset(content: string, format: string, language: string, provenance: Record<string, unknown>): Promise<{ hash: string; path: string }> {
  const body = content.replace(/^\uFEFF/, '');
  const saved = await saveBody(body, format);
  const current = database.prepare('SELECT storage_path,provenance FROM subtitle_assets WHERE content_hash=?').get(saved.hash) as { storage_path: string; provenance: string } | undefined;
  if (!current) recordSubtitleAssetBody(saved.hash, saved.path, format, language, Buffer.byteLength(body), provenance);
  else {
    let sources: unknown[] = [];
    try { const value = JSON.parse(current.provenance) as Record<string, unknown>; sources = Array.isArray(value.sources) ? value.sources : [value]; } catch { sources = []; }
    database.prepare('UPDATE subtitle_assets SET provenance=? WHERE content_hash=?').run(JSON.stringify({ sources: [...sources, provenance].slice(-32) }), saved.hash);
  }
  const source = provenance as { provider?: unknown; providerId?: unknown; sourceUrl?: unknown; attribution?: unknown };
  if (source.provider && source.providerId) database.prepare(`INSERT OR IGNORE INTO subtitle_asset_sources(content_hash,provider,provider_id,source_url,attribution,added_at) VALUES(?,?,?,?,?,?)`).run(saved.hash, String(source.provider), String(source.providerId), source.sourceUrl == null ? null : String(source.sourceUrl), source.attribution == null ? null : String(source.attribution), nowIso());
  return { hash: saved.hash, path: current?.storage_path ?? saved.path };
}

export function recordSubtitleAssetBody(hash: string, path: string, format: string, language: string, byteLength: number, provenance: Record<string, unknown>): void {
  database.prepare(`INSERT OR IGNORE INTO subtitle_assets(content_hash,format,language,storage_path,byte_length,provenance,created_at) VALUES(?,?,?,?,?,?,?)`).run(hash, format, language, path, byteLength, JSON.stringify(provenance), nowIso());
}

export async function readSubtitleAsset(hash: string): Promise<{ body: string; asset: Record<string, unknown> } | undefined> {
  const asset = database.prepare('SELECT * FROM subtitle_assets WHERE content_hash=?').get(hash) as Record<string, unknown> | undefined;
  if (!asset) return undefined;
  let body: string;
  try { body = await readBody(String(asset.storage_path)); }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
  const bodyHash = createHash('sha256').update(body).digest('hex');
  if (bodyHash !== hash || bodyHash !== String(asset.content_hash)) throw new Error(`Indexed subtitle asset hash mismatch: ${hash}`);
  if (Buffer.byteLength(body) !== Number(asset.byte_length)) throw new Error(`Indexed subtitle asset size mismatch: ${hash}`);
  return { body, asset };
}

export function upsertSubtitleIndex(input: SubtitleIndexInput): number {
  const normalized = { ...input, anidbId: input.anidbId ?? null, imdbId: input.imdbId ?? null, seasonNumber: input.seasonNumber ?? null, releaseGroup: input.releaseGroup ?? null, fileHash: input.fileHash ?? null, durationMs: input.durationMs ?? null, format: input.format ?? null, sourceUrl: input.sourceUrl ?? null, attribution: input.attribution ?? null, verified: Number(Boolean(input.verified)), catalogOnly: Number(Boolean(input.catalogOnly)), fetchable: Number(Boolean(input.fetchable)), assetHash: input.assetHash ?? null };
  database.prepare(`INSERT INTO subtitle_index(anime_id,anidb_id,imdb_id,season_number,episode_number,language,provider,provider_id,release_group,file_hash,duration_ms,format,source_url,attribution,quality_score,verified,catalog_only,fetchable,asset_hash,discovered_at)
    VALUES(@animeId,@anidbId,@imdbId,@seasonNumber,@episodeNumber,@language,@provider,@providerId,@releaseGroup,@fileHash,@durationMs,@format,@sourceUrl,@attribution,@qualityScore,@verified,@catalogOnly,@fetchable,@assetHash,@discoveredAt)
    ON CONFLICT(provider,provider_id) DO UPDATE SET anime_id=excluded.anime_id,anidb_id=COALESCE(excluded.anidb_id,subtitle_index.anidb_id),imdb_id=COALESCE(excluded.imdb_id,subtitle_index.imdb_id),season_number=COALESCE(excluded.season_number,subtitle_index.season_number),episode_number=excluded.episode_number,language=excluded.language,release_group=COALESCE(excluded.release_group,subtitle_index.release_group),file_hash=COALESCE(excluded.file_hash,subtitle_index.file_hash),duration_ms=COALESCE(excluded.duration_ms,subtitle_index.duration_ms),format=COALESCE(excluded.format,subtitle_index.format),source_url=COALESCE(excluded.source_url,subtitle_index.source_url),attribution=COALESCE(excluded.attribution,subtitle_index.attribution),quality_score=MAX(excluded.quality_score,subtitle_index.quality_score),verified=MAX(excluded.verified,subtitle_index.verified),catalog_only=excluded.catalog_only,fetchable=MAX(excluded.fetchable,subtitle_index.fetchable),asset_hash=COALESCE(excluded.asset_hash,subtitle_index.asset_hash)`).run({ ...normalized, discoveredAt: nowIso() });
  const id = Number((database.prepare('SELECT id FROM subtitle_index WHERE provider=? AND provider_id=?').get(input.provider, input.providerId) as { id: number }).id);
  if (!input.catalogOnly && input.qualityScore >= 0.5 && input.qualityScore < 0.85) {
    database.prepare(`INSERT INTO subtitle_index_verification_queue(index_id,state,reason,queued_at,updated_at) VALUES(?,'QUEUED','Match confidence is between 0.5 and 0.85',?,?) ON CONFLICT(index_id) DO NOTHING`).run(id, nowIso(), nowIso());
  }
  if (input.qualityScore >= 0.85 && input.verified) database.prepare(`DELETE FROM subtitle_index_verification_queue WHERE index_id=?`).run(id);
  return id;
}

export function markSubtitleIndexVerified(indexId: number, evidence: string): void {
  const row = database.prepare('SELECT quality_score,catalog_only,asset_hash FROM subtitle_index WHERE id=?').get(indexId) as { quality_score: number; catalog_only: number; asset_hash: string | null } | undefined;
  if (!row || row.catalog_only || !row.asset_hash || row.quality_score < 0.5 || row.quality_score >= 0.85) throw new Error('Only an indexed subtitle candidate with an attached asset and score 0.5–0.85 can be manually verified');
  const now = nowIso();
  const updateIndex = database.prepare('UPDATE subtitle_index SET verified=1 WHERE id=?');
  const updateQueue = database.prepare(`UPDATE subtitle_index_verification_queue SET state='VERIFIED',reason=?,updated_at=? WHERE index_id=? AND state IN ('QUEUED','RUNNING')`);
  const transaction = database.transaction(() => {
    updateIndex.run(indexId);
    const changed = updateQueue.run(evidence.slice(0, 1000), now, indexId).changes;
    if (!changed) throw new Error('Subtitle candidate is not waiting in the verification queue');
  });
  transaction();
}

export function markSubtitleIndexRejected(indexId: number, reason: string): void {
  const now = nowIso();
  const changed = database.prepare(`UPDATE subtitle_index_verification_queue SET state='REJECTED',reason=?,updated_at=? WHERE index_id=? AND state='QUEUED'`).run(reason.slice(0, 1000), now, indexId).changes;
  if (!changed) throw new Error('Subtitle candidate is not waiting in the verification queue');
}

export function subtitleIndexReviewQueue(limit = 100): Array<Record<string, unknown>> {
  return database.prepare(`SELECT q.index_id,q.reason,q.queued_at,i.anime_id,i.episode_number,i.provider,i.source_url,i.quality_score,i.attribution,t.romaji,t.english
    FROM subtitle_index_verification_queue q JOIN subtitle_index i ON i.id=q.index_id
    LEFT JOIN titles t ON CAST(t.id AS TEXT)=i.anime_id WHERE q.state='QUEUED' ORDER BY q.queued_at LIMIT ?`).all(Math.max(1, Math.min(500, limit))) as Array<Record<string, unknown>>;
}

export function addSubtitleTitleAliases(animeId: string, titles: string[]): void {
  const insert = database.prepare('INSERT OR IGNORE INTO subtitle_title_aliases(anime_id,normalized_title,display_title) VALUES(?,?,?)');
  const tx = database.transaction(() => { for (const title of titles) { const normalized = title.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim(); if (normalized) insert.run(animeId, normalized, title); } });
  tx();
}

export function resolveIndexedSubtitle(animeId: string, episode: number, language = 'bg', title?: string): Array<Record<string, unknown>> {
  const normalized = title?.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim() ?? '';
  return database.prepare(`SELECT i.*,a.storage_path,a.byte_length,a.format AS asset_format,q.state AS verification_state FROM subtitle_index i LEFT JOIN subtitle_assets a ON a.content_hash=i.asset_hash LEFT JOIN subtitle_index_verification_queue q ON q.index_id=i.id
    WHERE i.language=? AND i.episode_number IN (?,0) AND (i.anime_id=? OR (?<>'' AND i.anime_id IN (SELECT anime_id FROM subtitle_title_aliases WHERE normalized_title=?)))
    ORDER BY i.catalog_only ASC,i.verified DESC,i.quality_score DESC,i.discovered_at DESC`).all(language, episode, animeId, normalized, normalized) as Array<Record<string, unknown>>;
}
export function indexedSubtitleRows(animeId: string, episode: number): Array<Record<string, unknown>> {
  return database.prepare('SELECT provider,provider_id,quality_score FROM subtitle_index WHERE anime_id=? AND episode_number=?').all(animeId, episode) as Array<Record<string, unknown>>;
}

export function providerMissActive(animeId: string, episode: number, provider: string, now = Date.now()): boolean {
  return Boolean(database.prepare('SELECT 1 FROM subtitle_provider_misses WHERE anime_id=? AND episode_number=? AND provider=? AND expires_at>?').get(animeId, episode, provider, now));
}
export function recordProviderMiss(animeId: string, episode: number, provider: string, ttlMs = 7 * 24 * 60 * 60_000): void {
  database.prepare(`INSERT INTO subtitle_provider_misses(anime_id,episode_number,provider,expires_at) VALUES(?,?,?,?) ON CONFLICT(anime_id,episode_number,provider) DO UPDATE SET expires_at=excluded.expires_at`).run(animeId, episode, provider, Date.now() + ttlMs);
  database.prepare('DELETE FROM subtitle_provider_misses WHERE expires_at<=?').run(Date.now());
}
export function syncSubtitleProviderEnabled(provider: string, enabled: boolean): number {
  if (!/^[a-z0-9-]{1,64}$/.test(provider)) throw new Error('invalid subtitle provider id');
  const key = `provider-enabled:${provider}`;
  const sync = database.transaction(() => {
    const previous = database.prepare('SELECT value FROM subtitle_indexer_settings WHERE key=?').get(key) as { value: string } | undefined;
    let requeued = 0;
    if (enabled && previous?.value !== 'enabled') {
      requeued = database.prepare(`UPDATE subtitle_index_jobs SET state='QUEUED',attempts=0,available_at=0,locked_at=NULL,error=NULL,updated_at=?
        WHERE state IN ('COMPLETED','FAILED') AND EXISTS (
          SELECT 1 FROM subtitle_provider_misses m WHERE m.provider=? AND m.anime_id=subtitle_index_jobs.anime_id AND m.episode_number=subtitle_index_jobs.episode_number
        )`).run(nowIso(), provider).changes;
      database.prepare('DELETE FROM subtitle_provider_misses WHERE provider=?').run(provider);
    }
    database.prepare(`INSERT INTO subtitle_indexer_settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).run(key, enabled ? 'enabled' : 'disabled', nowIso());
    return requeued;
  }).immediate;
  return sync();
}
export function enqueueSubtitleIndexJob(input: { animeId: string; episode: number; season?: number | null; videoHash?: string | null; releaseGroup?: string | null; durationMs?: number | null }): boolean {
  const now = nowIso();
  const existing = database.prepare('SELECT id,state,updated_at,available_at FROM subtitle_index_jobs WHERE anime_id=? AND episode_number=?').get(input.animeId, input.episode) as { id: number; state: string; updated_at: string; available_at: number } | undefined;
  if (existing) {
    if (existing.state === 'QUEUED' || existing.state === 'RUNNING') return false;
    if (existing.state === 'COMPLETED' && Date.now() - Date.parse(existing.updated_at) < 7 * 24 * 60 * 60_000) return false;
    if (existing.state === 'FAILED' && existing.available_at > Date.now()) return false;
    return database.prepare(`UPDATE subtitle_index_jobs SET state='QUEUED',season_number=COALESCE(?,season_number),video_hash=COALESCE(?,video_hash),release_group=COALESCE(?,release_group),duration_ms=COALESCE(?,duration_ms),available_at=0,locked_at=NULL,error=NULL,updated_at=? WHERE id=?`).run(input.season ?? null, input.videoHash ?? null, input.releaseGroup ?? null, input.durationMs ?? null, now, existing.id).changes > 0;
  }
  const result = database.prepare(`INSERT INTO subtitle_index_jobs(anime_id,episode_number,season_number,video_hash,release_group,duration_ms,state,attempts,available_at,created_at,updated_at) VALUES(?,?,?,?,?,?,'QUEUED',0,0,?,?)
    ON CONFLICT(anime_id,episode_number) DO NOTHING`).run(input.animeId, input.episode, input.season ?? null, input.videoHash ?? null, input.releaseGroup ?? null, input.durationMs ?? null, now, now);
  return result.changes > 0;
}
export function claimSubtitleIndexJobs(limit: number, now = Date.now()): Array<Record<string, unknown>> {
  const claim = database.transaction(() => {
    const jobs = database.prepare(`SELECT * FROM subtitle_index_jobs WHERE (state='QUEUED' OR (state='FAILED' AND available_at<=?)) AND available_at<=? ORDER BY created_at,id LIMIT ?`).all(now, now, limit) as Array<Record<string, unknown>>;
    const update = database.prepare(`UPDATE subtitle_index_jobs SET state='RUNNING',attempts=attempts+1,locked_at=?,updated_at=? WHERE id=? AND state IN ('QUEUED','FAILED')`);
    for (const job of jobs) update.run(now, nowIso(), job.id);
    return jobs.map(job => database.prepare('SELECT * FROM subtitle_index_jobs WHERE id=?').get(job.id) as Record<string, unknown>);
  }).immediate;
  return claim();
}
export function recoverStaleSubtitleIndexJobs(staleMs = 2 * 60_000, now = Date.now()): number {
  const cutoff = now - staleMs;
  const recover = database.transaction(() => {
    const stale = database.prepare(`SELECT id,attempts FROM subtitle_index_jobs WHERE state='RUNNING' AND locked_at IS NOT NULL AND locked_at<?`).all(cutoff) as Array<{ id: number; attempts: number }>;
    const update = database.prepare(`UPDATE subtitle_index_jobs SET state=?,locked_at=NULL,available_at=?,error=?,updated_at=? WHERE id=? AND state='RUNNING' AND locked_at<?`);
    for (const job of stale) {
      const terminal = job.attempts >= 5;
      const reason = terminal ? 'Recovered after stale indexer lock; retry ceiling (5) reached' : 'Recovered after stale indexer lock';
      update.run(terminal ? 'FAILED' : 'QUEUED', terminal ? Number.MAX_SAFE_INTEGER : now, reason, nowIso(), job.id, cutoff);
    }
    return stale.length;
  }).immediate;
  return recover();
}
export function heartbeatSubtitleIndexJob(id: number, now = Date.now()): void {
  database.prepare(`UPDATE subtitle_index_jobs SET locked_at=?,updated_at=? WHERE id=? AND state='RUNNING'`).run(now, nowIso(), id);
}
export function finishSubtitleIndexJob(id: number, error?: string): void {
  const row = database.prepare('SELECT attempts FROM subtitle_index_jobs WHERE id=?').get(id) as { attempts: number } | undefined;
  if (!row) return;
  const terminal = Boolean(error) && row.attempts >= 5;
  const backoff = Math.min(24 * 60 * 60_000, 30_000 * (2 ** Math.max(0, row.attempts - 1)));
  database.prepare('UPDATE subtitle_index_jobs SET state=?,error=?,locked_at=NULL,available_at=?,updated_at=? WHERE id=?').run(error ? (terminal ? 'FAILED' : 'QUEUED') : 'COMPLETED', error ?? null, error ? Date.now() + backoff : 0, nowIso(), id);
}
const HTTP_CACHE_MAX_BODY_BYTES = 2 * 1024 * 1024;
const HTTP_CACHE_MAX_ROWS = 1000;
const HTTP_CACHE_TTL_MS = 30 * 24 * 60 * 60_000;
let httpCacheWrites = 0;
export function indexerHttpCache(key: string): { etag: string | null; lastModified: string | null; body: string | null; status: number | null } | undefined {
  const row = database.prepare('SELECT etag,last_modified,response_body,response_status FROM subtitle_provider_http_cache WHERE cache_key=?').get(key) as { etag: string | null; last_modified: string | null; response_body: string | null; response_status: number | null } | undefined;
  return row && { etag: row.etag, lastModified: row.last_modified, body: row.response_body, status: row.response_status };
}
export function saveIndexerHttpCache(key: string, input: { etag?: string | null; lastModified?: string | null; body?: string | null; status?: number | null }): void {
  const body = input.body && Buffer.byteLength(input.body) <= HTTP_CACHE_MAX_BODY_BYTES ? input.body : null;
  database.prepare(`INSERT INTO subtitle_provider_http_cache(cache_key,etag,last_modified,response_body,response_status,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(cache_key) DO UPDATE SET etag=COALESCE(excluded.etag,subtitle_provider_http_cache.etag),last_modified=COALESCE(excluded.last_modified,subtitle_provider_http_cache.last_modified),response_body=COALESCE(excluded.response_body,subtitle_provider_http_cache.response_body),response_status=COALESCE(excluded.response_status,subtitle_provider_http_cache.response_status),updated_at=excluded.updated_at`).run(key, input.etag ?? null, input.lastModified ?? null, body, input.status ?? null, nowIso());
  httpCacheWrites++;
  if (httpCacheWrites % 25 === 0) {
    const cutoff = new Date(Date.now() - HTTP_CACHE_TTL_MS).toISOString();
    database.prepare('DELETE FROM subtitle_provider_http_cache WHERE updated_at<?').run(cutoff);
    database.prepare(`DELETE FROM subtitle_provider_http_cache WHERE cache_key IN (SELECT cache_key FROM subtitle_provider_http_cache ORDER BY updated_at DESC LIMIT -1 OFFSET ?)` ).run(HTTP_CACHE_MAX_ROWS);
  }
}

export function pruneSubtitleOperationalData(now = Date.now(), retentionDays = subtitleConfig.logRetentionDays, maxLogRows = subtitleConfig.maxLogRows): { expiredProviderMisses: number; expiredHttpCache: number; expiredLogs: number; excessLogs: number } {
  const cutoff = new Date(now - retentionDays * 24 * 60 * 60_000).toISOString();
  const transaction = database.transaction(() => {
    const expiredProviderMisses = database.prepare('DELETE FROM subtitle_provider_misses WHERE expires_at<=?').run(now).changes;
    const expiredHttpCache = database.prepare('DELETE FROM subtitle_provider_http_cache WHERE updated_at<?').run(new Date(now - HTTP_CACHE_TTL_MS).toISOString()).changes;
    const expiredLogs = database.prepare('DELETE FROM subtitle_job_logs WHERE created_at<?').run(cutoff).changes;
    const currentLogs = Number((database.prepare('SELECT COUNT(*) AS count FROM subtitle_job_logs').get() as { count: number }).count);
    const excessLogs = Math.max(0, currentLogs - maxLogRows);
    if (excessLogs) database.prepare(`DELETE FROM subtitle_job_logs WHERE id IN (SELECT id FROM subtitle_job_logs ORDER BY id ASC LIMIT ?)` ).run(excessLogs);
    return { expiredProviderMisses, expiredHttpCache, expiredLogs, excessLogs };
  }).immediate;
  return transaction();
}
export function subtitleIndexStats(): Record<string, number> {
  const rows = database.prepare(`SELECT provider,COUNT(*) AS count,SUM(CASE WHEN catalog_only=1 THEN 1 ELSE 0 END) AS catalog_only,SUM(CASE WHEN asset_hash IS NOT NULL THEN 1 ELSE 0 END) AS assets FROM subtitle_index GROUP BY provider`).all() as Array<{ provider: string; count: number; catalog_only: number; assets: number }>;
  const jobs = database.prepare(`SELECT state,COUNT(*) AS count FROM subtitle_index_jobs GROUP BY state`).all() as Array<{ state: string; count: number }>;
  const count = (state: string) => Number(jobs.find(job => job.state === state)?.count ?? 0);
  const assetCount = Number((database.prepare('SELECT COUNT(*) AS count FROM subtitle_assets').get() as { count: number }).count);
  const playableRows = Number((database.prepare(`SELECT COUNT(*) AS count FROM subtitle_index i LEFT JOIN subtitle_index_verification_queue q ON q.index_id=i.id WHERE i.catalog_only=0 AND i.fetchable=1 AND i.asset_hash IS NOT NULL AND i.verified=1 AND (i.quality_score>=0.85 OR q.state='VERIFIED')`).get() as { count: number }).count);
  const catalogOnlyRows = Number((database.prepare('SELECT COUNT(*) AS count FROM subtitle_index WHERE catalog_only=1').get() as { count: number }).count);
  const verifiedRows = Number((database.prepare(`SELECT COUNT(*) AS count FROM subtitle_index i LEFT JOIN subtitle_index_verification_queue q ON q.index_id=i.id WHERE i.catalog_only=0 AND i.verified=1 AND (i.quality_score>=0.85 OR q.state='VERIFIED')`).get() as { count: number }).count);
  return { titles: Number((database.prepare('SELECT COUNT(DISTINCT anime_id) AS count FROM subtitle_index').get() as { count: number }).count), entries: Number((database.prepare('SELECT COUNT(*) AS count FROM subtitle_index').get() as { count: number }).count), assets: assetCount, playableRows, catalogOnlyRows, verifiedRows, verificationQueued: Number((database.prepare("SELECT COUNT(*) AS count FROM subtitle_index_verification_queue WHERE state='QUEUED'").get() as { count: number }).count), providers: rows.length, queued: count('QUEUED'), running: count('RUNNING'), completed: count('COMPLETED'), failed: count('FAILED') };
}
export function subtitleIndexProviderBreakdown(): Array<{ provider: string; indexedRows: number; playableRows: number; catalogOnlyRows: number; verifiedRows: number }> {
  return database.prepare(`SELECT i.provider,COUNT(*) AS indexedRows,
    SUM(CASE WHEN i.catalog_only=0 AND i.fetchable=1 AND i.asset_hash IS NOT NULL AND i.verified=1 AND (i.quality_score>=0.85 OR q.state='VERIFIED') THEN 1 ELSE 0 END) AS playableRows,
    SUM(CASE WHEN i.catalog_only=1 THEN 1 ELSE 0 END) AS catalogOnlyRows,
    SUM(CASE WHEN i.catalog_only=0 AND i.verified=1 AND (i.quality_score>=0.85 OR q.state='VERIFIED') THEN 1 ELSE 0 END) AS verifiedRows
    FROM subtitle_index i LEFT JOIN subtitle_index_verification_queue q ON q.index_id=i.id GROUP BY i.provider ORDER BY i.provider`).all() as Array<{ provider: string; indexedRows: number; playableRows: number; catalogOnlyRows: number; verifiedRows: number }>;
}

export function enqueueJob(animeId: number, episodeId: number, target = 'bg'): Job {
  return enqueueJobOnce(animeId, episodeId, target).job;
}
export function queuePriority(animeId: number): number {
  // DECISION: manual operator overrides must work even when an AniList title has not yet
  // appeared in the popularity synchronization table (for example, a newly announced season).
  const directOverride = database.prepare(`SELECT priority FROM subtitle_priority_overrides WHERE anilist_id=? AND season_label=''`).get(animeId) as { priority: number } | undefined;
  if (directOverride) return 100000 + directOverride.priority;
  const coverage = database.prepare(`SELECT COUNT(e.number) AS total,
    SUM(CASE WHEN EXISTS(SELECT 1 FROM subtitle_artifacts a WHERE a.anime_id=e.title_id AND a.episode_id=CAST(e.number AS TEXT) AND a.target_language='bg' AND a.validation_status='validated')
      OR EXISTS(SELECT 1 FROM subs s WHERE s.title_id=e.title_id AND s.number=e.number AND s.status IN ('qc','final') AND s.path IS NOT NULL) THEN 1 ELSE 0 END) AS available
    FROM episodes e WHERE e.title_id=?`).get(animeId) as { total:number; available:number|null }|undefined;
  if (coverage && coverage.available != null && coverage.available > 0 && coverage.available < coverage.total) return 90000;
  const item = database.prepare(`SELECT p.anilist_id,p.rank,p.popularity,o.priority AS override_priority
    FROM anime_popularity p LEFT JOIN subtitle_priority_overrides o
      ON o.anilist_id=p.anilist_id AND o.season_label=''
    WHERE p.anime_id=? ORDER BY p.match_score DESC,p.rank ASC LIMIT 1`).get(animeId) as { anilist_id:number; rank:number; popularity:number; override_priority:number|null }|undefined;
  if (!item) return 0;
  if (item.override_priority != null) return 100000 + item.override_priority;
  const tier = item.rank <= 10 ? 5 : item.rank <= 25 ? 4 : item.rank <= 50 ? 3 : item.rank <= 100 ? 2 : 1;
  return tier * 1000 + item.popularity / 1000;
}
export function subtitleQueueDepth(): number {
  return Number((database.prepare(`SELECT COUNT(*) AS count FROM subtitle_jobs WHERE status IN ('DISCOVERED','QUEUED','DOWNLOADING','NORMALIZING','TRANSLATING','VALIDATING') OR (status='FAILED' AND attempts<? AND available_at<${Number.MAX_SAFE_INTEGER})`).get(subtitleConfig.retryCount + 3) as { count: number }).count);
}
export function requeueExpiredSubtitleSources(limit = 100, now = Date.now()): number {
  const count = Math.max(1, Math.min(1000, Math.floor(limit)));
  const timestamp = nowIso();
  return database.transaction(() => {
    const rows = database.prepare(`SELECT id FROM subtitle_jobs WHERE status='SKIPPED' AND error IN ('no subtitle source','no usable English or Japanese subtitle source') AND available_at<=? ORDER BY priority DESC,available_at,id LIMIT ?`).all(now, count) as Array<{ id: number }>;
    const update = database.prepare(`UPDATE subtitle_jobs SET status='QUEUED',attempts=0,available_at=0,locked_at=NULL,lease_expires_at=NULL,worker_id=NULL,error=NULL,updated_at=? WHERE id=? AND status='SKIPPED' AND error IN ('no subtitle source','no usable English or Japanese subtitle source') AND available_at<=?`);
    for (const row of rows) update.run(timestamp, row.id, now);
    return rows.length;
  }).immediate();
}
export function enqueueJobOnce(animeId: number, episodeId: number, target = 'bg'): { job: Job; inserted: boolean } {
  const now = nowIso();
  const result = database.prepare(`INSERT INTO subtitle_jobs(anime_id,episode_id,target_language,status,created_at,updated_at,priority) VALUES(?,?,?,'DISCOVERED',?,?,?) ON CONFLICT(anime_id,episode_id,target_language) DO NOTHING`).run(animeId, String(episodeId), target, now, now, queuePriority(animeId));
  const row = database.prepare('SELECT * FROM subtitle_jobs WHERE anime_id=? AND episode_id=? AND target_language=?').get(animeId, String(episodeId), target) as Record<string, unknown>;
  const job = fromRow(row);
  if (job.status === 'DISCOVERED') updateJob(job.id, 'QUEUED');
  return { job: getJob(job.id)!, inserted: result.changes === 1 };
}
export function enqueueOnDemandJob(animeId: number, episodeId: number, target = 'bg', retryCooldownMs = 5 * 60_000): Job {
  const { job } = enqueueJobOnce(animeId, episodeId, target);
  if (job.status === 'FAILED' && job.available_at === Number.MAX_SAFE_INTEGER && Date.now() - Date.parse(job.updated_at) >= retryCooldownMs) {
    database.prepare(`UPDATE subtitle_jobs SET status='QUEUED',attempts=0,available_at=0,locked_at=NULL,error=NULL,updated_at=? WHERE id=? AND status='FAILED' AND available_at=?`).run(nowIso(), job.id, Number.MAX_SAFE_INTEGER);
    logJob(job.id, 'info', 'on_demand_retry_queued', { previousError: job.error, previousAttempts: job.attempts });
  }
  if (job.status === 'SKIPPED' && /^no subtitle source$/i.test(job.error ?? '') && job.available_at <= Date.now()) {
    database.prepare(`UPDATE subtitle_jobs SET status='QUEUED',attempts=0,available_at=0,locked_at=NULL,error=NULL,updated_at=? WHERE id=? AND status='SKIPPED' AND available_at<=?`).run(nowIso(), job.id, Date.now());
    logJob(job.id, 'info', 'no_source_rediscovery_queued', { previousError: job.error });
  }
  const latest = getJob(job.id)!;
  if (['QUEUED', 'DISCOVERED'].includes(latest.status) && latest.checkpoint.onDemand !== true) {
    updateJob(job.id, latest.status, { checkpoint: { ...latest.checkpoint, onDemand: true }, lockedAt: null });
  }
  return getJob(job.id)!;
}
export function getJob(id: number): Job | undefined { const row = database.prepare('SELECT * FROM subtitle_jobs WHERE id=?').get(id) as Record<string, unknown> | undefined; return row && fromRow(row); }
export function heartbeatJob(id: number): void { database.prepare(`UPDATE subtitle_jobs SET locked_at=? WHERE id=? AND status IN ('DOWNLOADING','NORMALIZING','TRANSLATING','VALIDATING')`).run(Date.now(), id); }
export function updateJob(id: number, status: JobState, patch: { sourceLanguage?: string; providerId?: string; sourceHash?: string; error?: string | null; checkpoint?: Record<string, unknown>; lockedAt?: number | null; attempts?: number; availableAt?: number; workerId?: string | null; leaseExpiresAt?: number | null } = {}): void {
  const current = getJob(id);
  if (!current) throw new Error(`Subtitle job ${id} does not exist`);
  const next = { status, source_language: patch.sourceLanguage ?? current.source_language, provider_id: patch.providerId ?? current.provider_id, source_hash: patch.sourceHash ?? current.source_hash, error: patch.error === undefined ? current.error : patch.error, checkpoint: JSON.stringify(patch.checkpoint ?? current.checkpoint), locked_at: patch.lockedAt === undefined ? (['COMPLETED', 'FAILED', 'SKIPPED'].includes(status) ? null : Date.now()) : patch.lockedAt, attempts: patch.attempts ?? current.attempts, available_at: patch.availableAt ?? current.available_at, worker_id: patch.workerId === undefined ? current.worker_id ?? null : patch.workerId, lease_expires_at: patch.leaseExpiresAt === undefined ? current.lease_expires_at ?? null : patch.leaseExpiresAt, updated_at: nowIso(), id };
  database.prepare(`UPDATE subtitle_jobs SET status=@status,source_language=@source_language,provider_id=@provider_id,source_hash=@source_hash,error=@error,checkpoint=@checkpoint,locked_at=@locked_at,attempts=@attempts,available_at=@available_at,worker_id=@worker_id,lease_expires_at=@lease_expires_at,updated_at=@updated_at WHERE id=@id`).run(next);
}
export function logJob(jobId: number, level: 'info' | 'warn' | 'error', event: string, details: Record<string, unknown> = {}): void {
  database.prepare('INSERT INTO subtitle_job_logs(job_id,created_at,level,event,details) VALUES(?,?,?,?,?)').run(jobId, nowIso(), level, event, JSON.stringify(details));
}
export function recoverStaleJobs(staleMs: number, now = Date.now()): number {
  const cutoff = now - staleMs;
  const maximumAttempts = subtitleConfig.retryCount + 3;
  const recover = database.transaction(() => {
    const stale = database.prepare(`SELECT * FROM subtitle_jobs WHERE status IN ('DOWNLOADING','NORMALIZING','TRANSLATING','VALIDATING') AND COALESCE(lease_expires_at,locked_at) IS NOT NULL AND COALESCE(lease_expires_at,locked_at) < ?`).all(cutoff) as Array<Record<string, unknown>>;
    const update = database.prepare(`UPDATE subtitle_jobs SET status=?,locked_at=NULL,lease_expires_at=NULL,worker_id=NULL,available_at=?,updated_at=?,error=? WHERE id=? AND status IN ('DOWNLOADING','NORMALIZING','TRANSLATING','VALIDATING') AND COALESCE(lease_expires_at,locked_at) < ?`);
    for (const row of stale) {
      const job = fromRow(row);
      const terminal = job.attempts >= maximumAttempts;
      const reason = terminal ? `Recovered after stale worker lock; retry ceiling (${maximumAttempts}) reached` : 'Recovered after stale worker lock';
      update.run(terminal ? 'FAILED' : 'QUEUED', terminal ? Number.MAX_SAFE_INTEGER : now, nowIso(), reason, job.id, cutoff);
      if (terminal) {
        addDeadLetter({ ...job, status: 'FAILED', error: reason, locked_at: null, available_at: Number.MAX_SAFE_INTEGER }, reason);
        logJob(job.id, 'error', 'stale_job_dead_lettered', { attempts: job.attempts, retryCeiling: maximumAttempts });
      } else logJob(job.id, 'warn', 'stale_job_recovered', { attempts: job.attempts });
    }
    return stale.length;
  }).immediate;
  return recover();
}
export type WorkerControl = 'running' | 'paused' | 'stopping';
export function workerControl(): WorkerControl { const row = database.prepare(`SELECT value FROM subtitle_worker_settings WHERE key='control'`).get() as { value: string } | undefined; return (row?.value as WorkerControl) ?? 'running'; }
export function setWorkerControl(value: WorkerControl): void { database.prepare(`INSERT INTO subtitle_worker_settings(key,value,updated_at) VALUES('control',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).run(value, nowIso()); }
export function compareAndSetWorkerControl(expected: WorkerControl, next: WorkerControl): boolean {
  return database.prepare(`UPDATE subtitle_worker_settings SET value=?,updated_at=? WHERE key='control' AND value=?`).run(next, nowIso(), expected).changes === 1;
}
export function recordWorkerHeartbeat(at = Date.now()): void { database.prepare(`INSERT INTO subtitle_worker_settings(key,value,updated_at) VALUES('worker-heartbeat',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).run(String(at), nowIso()); }
export function workerProcessStatus(now = Date.now(), staleAfterMs = 30_000): 'running' | 'stopped' {
  const row = database.prepare(`SELECT value FROM subtitle_worker_settings WHERE key='worker-heartbeat'`).get() as { value: string } | undefined;
  const heartbeat = Number(row?.value ?? 0);
  return Number.isFinite(heartbeat) && heartbeat > 0 && now - heartbeat <= staleAfterMs ? 'running' : 'stopped';
}
export function workerConcurrency(): number { const row = database.prepare(`SELECT value FROM subtitle_worker_settings WHERE key='concurrency'`).get() as { value: string } | undefined; return row ? Math.max(1, Math.min(subtitleConfig.maxConcurrentJobs, Number(row.value) || 1)) : subtitleConfig.maxConcurrentJobs; }
export function setWorkerConcurrency(value: number): void { database.prepare(`INSERT INTO subtitle_worker_settings(key,value,updated_at) VALUES('concurrency',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).run(String(Math.max(1, Math.min(subtitleConfig.maxConcurrentJobs, Math.floor(value)))), nowIso()); }
export function persistModelStatus(value: Record<string, unknown>): void { database.prepare(`INSERT INTO subtitle_worker_settings(key,value,updated_at) VALUES('models',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).run(JSON.stringify(value), nowIso()); }
export function persistedModelStatus(): Record<string, unknown> | null { const row = database.prepare(`SELECT value FROM subtitle_worker_settings WHERE key='models'`).get() as { value: string } | undefined; return row ? JSON.parse(row.value) as Record<string, unknown> : null; }
export function persistSubtitleProviderState(provider: string, state: Record<string, unknown>): void {
  database.prepare(`INSERT INTO subtitle_worker_settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).run(`provider:${provider}`, JSON.stringify(state), nowIso());
}
export function subtitleProviderStates(): Record<string, Record<string, unknown>> {
  const rows = database.prepare(`SELECT key,value FROM subtitle_worker_settings WHERE key LIKE 'provider:%'`).all() as Array<{ key: string; value: string }>;
  return Object.fromEntries(rows.map(row => [row.key.slice('provider:'.length), JSON.parse(row.value) as Record<string, unknown>]));
}
export function storedBulgarianCount(): number { const row = database.prepare(`SELECT COUNT(*) AS count FROM (SELECT anime_id,episode_id FROM subtitle_artifacts WHERE target_language='bg' AND validation_status='validated' UNION SELECT title_id,CAST(number AS TEXT) FROM subs WHERE status IN ('qc','final') AND path IS NOT NULL)`).get() as { count: number }; return row.count; }
export function claimJobs(limit: number, mode: 'online'|'kaggle' = subtitleConfig.translationMode): Job[] {
  const now = Date.now();
  const transaction = database.transaction(() => {
    const rows = database.prepare(`SELECT j.* FROM subtitle_jobs j WHERE j.status IN ('QUEUED','FAILED') AND j.available_at<=? AND ?='online' ORDER BY CASE json_extract(j.checkpoint,'$.onDemand') WHEN 1 THEN 0 ELSE 1 END, j.priority DESC, CASE j.source_language WHEN 'en' THEN 0 WHEN 'ja' THEN 1 ELSE 2 END, (SELECT COUNT(*) FROM episodes e WHERE e.title_id=j.anime_id) DESC, CASE j.status WHEN 'FAILED' THEN 1 ELSE 0 END, j.attempts, j.anime_id, CAST(j.episode_id AS REAL), j.episode_id LIMIT ?`).all(now, mode, limit) as Array<Record<string, unknown>>;
    const update = database.prepare(`UPDATE subtitle_jobs SET status='DOWNLOADING',locked_at=?,lease_expires_at=NULL,worker_id=NULL,updated_at=?,attempts=attempts+1 WHERE id=? AND status IN ('QUEUED','FAILED')`);
    for (const row of rows) update.run(now, nowIso(), row.id);
    return rows.map(row => getJob(Number(row.id))!).filter(job => job.status === 'DOWNLOADING');
  }).immediate;
  return transaction();
}

export function syncAniListPopularity(entries: Array<{ id: number; title: string; romaji: string | null; english: string | null; native: string | null; synonyms: string[]; popularity: number; rank: number; format: string | null; seasonYear: number | null }>): number {
  const local = database.prepare('SELECT id,romaji,english,native,title_bg FROM titles').all() as Array<{ id:number;romaji:string|null;english:string|null;native:string|null;title_bg:string|null }>;
  const normalize = (value: string) => value.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const exact = new Map<string,number>();
  for (const title of local) for (const name of [title.romaji,title.english,title.native,title.title_bg]) if(name) exact.set(normalize(name),title.id);
  const put = database.prepare(`INSERT INTO anime_popularity(anilist_id,anime_id,title,romaji,english,native,synonyms,popularity,rank,format,season_year,synced_at,match_score) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(anilist_id) DO UPDATE SET anime_id=excluded.anime_id,title=excluded.title,romaji=excluded.romaji,english=excluded.english,native=excluded.native,synonyms=excluded.synonyms,popularity=excluded.popularity,rank=excluded.rank,format=excluded.format,season_year=excluded.season_year,synced_at=excluded.synced_at,match_score=excluded.match_score`);
    const updatePriority = database.prepare(`UPDATE subtitle_jobs SET priority=? WHERE anime_id=? AND status NOT IN ('COMPLETED','SKIPPED')`);
  const now = nowIso(); let matched = 0;
  const transaction = database.transaction(() => { for (const item of entries) {
    const names = [item.romaji,item.english,item.native,...item.synonyms].filter((value):value is string=>Boolean(value));
    const exactId = names.map(name=>exact.get(normalize(name))).find(value=>value!==undefined);
    let id = exactId ?? (local.some(row=>row.id===item.id)?item.id:null);
    let score=id==null?0:100;
    if(id==null) {
      const ranked=local.map(row=>({row,score:scoreTitleMatch({romaji:item.romaji,english:item.english,native:item.native,synonyms:item.synonyms},[row.romaji,row.english,row.native,row.title_bg].filter(Boolean).join(' '))})).sort((a,b)=>b.score-a.score);
      if(ranked[0]?.score>=85 && (!ranked[1] || ranked[0].score-ranked[1].score>=5)){id=ranked[0].row.id;score=ranked[0].score;}
    }
    if(id!=null) matched++;
    put.run(item.id,id,item.title,item.romaji,item.english,item.native,JSON.stringify(item.synonyms),item.popularity,item.rank,item.format,item.seasonYear,now,score);
    const tier=item.rank<=10?5:item.rank<=25?4:item.rank<=50?3:item.rank<=100?2:1;
    if(id!=null) {
      const override=database.prepare('SELECT priority FROM subtitle_priority_overrides WHERE anilist_id=? AND season_label IN (?,?) ORDER BY CASE WHEN season_label=? THEN 0 ELSE 1 END LIMIT 1').get(item.id, String(item.seasonYear??''), '', String(item.seasonYear??'')) as {priority:number}|undefined;
      updatePriority.run(override ? 100000+override.priority : tier*1000+item.popularity/1000,id);
    }
  } }); transaction(); return matched;
}
export function setSubtitlePriorityOverride(anilistId:number, priority:number, reason:string, seasonLabel=''):void {
  if(!Number.isSafeInteger(anilistId)||anilistId<1||!Number.isFinite(priority)||priority<0||priority>100000||reason.length>300||seasonLabel.length>80) throw new Error('invalid subtitle priority override');
  database.prepare(`INSERT INTO subtitle_priority_overrides(anilist_id,season_label,priority,reason,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(anilist_id,season_label) DO UPDATE SET priority=excluded.priority,reason=excluded.reason,updated_at=excluded.updated_at`).run(anilistId,seasonLabel,priority,reason,nowIso());
  const row=database.prepare('SELECT anime_id FROM anime_popularity WHERE anilist_id=?').get(anilistId) as {anime_id:number|null}|undefined;
  if(row?.anime_id!=null) database.prepare(`UPDATE subtitle_jobs SET priority=? WHERE anime_id=? AND status NOT IN ('COMPLETED','SKIPPED')`).run(100000+priority,row.anime_id);
}
export interface KaggleQueueDiagnostics {
  totalJobs: number;
  pendingJobs: number;
  availablePendingJobs: number;
  eligibleJobs: number;
  byStatus: Record<string, number>;
  bySourceLanguage: Record<'en'|'ja'|'missing'|'unsupported', number>;
  excludedByStatus: number;
  excludedBySourceLanguage: number;
  excludedByMissingMetadata: number;
  excludedByLease: number;
  excludedByRetryLimit: number;
  excludedByRetryDelay: number;
  activeProcessing: number;
}

function kaggleLanguage(value: unknown): 'en'|'ja'|'missing'|'unsupported' {
  if (typeof value !== 'string' || !value.trim()) return 'missing';
  const language = value.trim().toLowerCase();
  const base = language.split(/[-_]/, 1)[0] ?? language;
  if (['en','eng','english'].includes(base)) return 'en';
  if (['ja','jpn','japanese'].includes(base)) return 'ja';
  return 'unsupported';
}

export function kaggleQueueDiagnostics(now=Date.now(), retryLimit=subtitleConfig.retryCount+3): KaggleQueueDiagnostics {
  const rows = database.prepare(`SELECT status,source_language,available_at,attempts,lease_expires_at,source_hash,
      json_type(checkpoint,'$.sourcePath') AS source_path_type,
      json_extract(checkpoint,'$.sourcePath') AS source_path
    FROM subtitle_jobs`).all() as Array<{status:string;source_language:string|null;available_at:number;attempts:number;lease_expires_at:number|null;source_hash:string|null;source_path_type:string|null;source_path:string|null}>;
  const byStatus:Record<string,number>={};
  const bySourceLanguage:KaggleQueueDiagnostics['bySourceLanguage']={en:0,ja:0,missing:0,unsupported:0};
  let pendingJobs=0,availablePendingJobs=0,eligibleJobs=0,excludedByStatus=0,excludedBySourceLanguage=0;
  let excludedByMissingMetadata=0,excludedByLease=0,excludedByRetryLimit=0,excludedByRetryDelay=0,activeProcessing=0;
  for(const row of rows){
    byStatus[row.status]=(byStatus[row.status]??0)+1;
    const active=['DOWNLOADING','NORMALIZING','TRANSLATING','VALIDATING'].includes(row.status);
    if(active) activeProcessing++;
    if(row.status!=='QUEUED'&&row.status!=='FAILED'){excludedByStatus++;continue;}
    pendingJobs++;
    const available=row.available_at<=now;
    if(!available){
      if(row.available_at>=Number.MAX_SAFE_INTEGER||row.attempts>=retryLimit) excludedByRetryLimit++;
      else excludedByRetryDelay++;
      continue;
    }
    availablePendingJobs++;
    const language=kaggleLanguage(row.source_language);
    bySourceLanguage[language]++;
    if(row.attempts>=retryLimit||row.available_at>=Number.MAX_SAFE_INTEGER){excludedByRetryLimit++;continue;}
    if(language==='missing'||language==='unsupported'){excludedBySourceLanguage++;continue;}
    if(row.source_path_type!=='text'||!row.source_path?.trim()||!row.source_hash?.trim()){
      excludedByMissingMetadata++;
      continue;
    }
    if(row.lease_expires_at!==null&&row.lease_expires_at>now){excludedByLease++;continue;}
    eligibleJobs++;
  }
  return {totalJobs:rows.length,pendingJobs,availablePendingJobs,eligibleJobs,byStatus,bySourceLanguage,excludedByStatus,excludedBySourceLanguage,excludedByMissingMetadata,excludedByLease,excludedByRetryLimit,excludedByRetryDelay,activeProcessing};
}

export function claimKaggleJobs(workerId:string, limit=1, leaseMs=120_000):Job[] {
  if(typeof workerId!=='string'||!/^[a-zA-Z0-9._-]{1,80}$/.test(workerId)) throw new Error('invalid worker id');
  const now=Date.now(); const count=Math.max(1,Math.min(2,Math.floor(limit))); const retryLimit=subtitleConfig.retryCount+3;
  const supportedLanguage=`(
    lower(trim(source_language)) IN ('en','eng','english','ja','jpn','japanese')
    OR (substr(lower(trim(source_language)),1,2)='en' AND substr(lower(trim(source_language)),3,1) IN ('_','-'))
    OR (substr(lower(trim(source_language)),1,2)='ja' AND substr(lower(trim(source_language)),3,1) IN ('_','-'))
    OR (substr(lower(trim(source_language)),1,3)='eng' AND substr(lower(trim(source_language)),4,1) IN ('_','-'))
    OR (substr(lower(trim(source_language)),1,3)='jpn' AND substr(lower(trim(source_language)),4,1) IN ('_','-'))
  )`;
  return database.transaction(()=>{
    const rows=database.prepare(`SELECT * FROM subtitle_jobs
      WHERE status IN ('QUEUED','FAILED') AND available_at<=? AND attempts<?
        AND (lease_expires_at IS NULL OR lease_expires_at<=?)
        AND ${supportedLanguage}
        AND json_type(checkpoint,'$.sourcePath')='text'
        AND length(trim(json_extract(checkpoint,'$.sourcePath')))>0
        AND source_hash IS NOT NULL AND length(trim(source_hash))>0
      ORDER BY CASE json_extract(checkpoint,'$.onDemand') WHEN 1 THEN 0 ELSE 1 END,priority DESC,
        CASE substr(lower(trim(source_language)),1,2) WHEN 'en' THEN 0 ELSE 1 END,
        attempts,anime_id,CAST(episode_id AS REAL),episode_id LIMIT ?`).all(now,retryLimit,now,count) as Array<Record<string,unknown>>;
    const claim=database.prepare(`UPDATE subtitle_jobs SET status='DOWNLOADING',locked_at=?,lease_expires_at=?,worker_id=?,updated_at=?,attempts=attempts+1 WHERE id=? AND status IN ('QUEUED','FAILED') AND available_at<=? AND attempts<? AND (lease_expires_at IS NULL OR lease_expires_at<=?)`);
    for(const row of rows) claim.run(now,now+leaseMs,workerId,nowIso(),row.id,now,retryLimit,now);
    return rows.map(row=>getJob(Number(row.id))!).filter(job=>job.status==='DOWNLOADING');
  }).immediate();
}
export function heartbeatKaggleLease(jobId:number,workerId:string,leaseMs=120_000):boolean {
  const now=Date.now();
  return database.prepare(`UPDATE subtitle_jobs SET locked_at=?,lease_expires_at=?,updated_at=? WHERE id=? AND worker_id=? AND status IN ('DOWNLOADING','NORMALIZING','TRANSLATING','VALIDATING')`).run(now,now+leaseMs,nowIso(),jobId,workerId).changes===1;
}
export function claimUndiscoveredJobs(limit: number): Job[] {
  const now = Date.now();
  const retryLimit = subtitleConfig.retryCount + 3;
  const transaction = database.transaction(() => {
    const rows = database.prepare(`SELECT j.* FROM subtitle_jobs j WHERE j.source_language IS NULL AND (j.status='QUEUED' OR (j.status='FAILED' AND j.available_at<=? AND j.attempts<?)) ORDER BY CASE json_extract(j.checkpoint,'$.onDemand') WHEN 1 THEN 0 ELSE 1 END,j.priority DESC,(SELECT COUNT(*) FROM episodes e WHERE e.title_id=j.anime_id) DESC,j.anime_id,CAST(j.episode_id AS REAL),j.episode_id LIMIT ?`).all(now,retryLimit,limit) as Array<Record<string, unknown>>;
    const update = database.prepare(`UPDATE subtitle_jobs SET status='DOWNLOADING',locked_at=?,updated_at=?,attempts=attempts+1 WHERE id=? AND source_language IS NULL AND (status='QUEUED' OR (status='FAILED' AND available_at<=? AND attempts<?))`);
    for (const row of rows) update.run(now, nowIso(), row.id, now, retryLimit);
    return rows.map(row => getJob(Number(row.id))!).filter(job => job.status === 'DOWNLOADING');
  }).immediate;
  return transaction();
}
export function saveBody(content: string, extension: string): Promise<{ hash: string; path: string }> {
  const contentHash = createHash('sha256').update(content).digest('hex');
  const safeExt = extension.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'txt';
  const path = resolve(bodyRoot, contentHash.slice(0, 2), `${contentHash}.${safeExt}`);
  return mkdir(dirname(path), { recursive: true }).then(async () => {
    const verifyExisting = async (): Promise<boolean> => {
      try {
        const existing = await readFile(path);
        if (createHash('sha256').update(existing).digest('hex') !== contentHash) throw new Error(`Content-addressed subtitle body failed integrity check: ${path}`);
        return true;
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false;
        throw error;
      }
    };
    if (await verifyExisting()) return { hash: contentHash, path };

    // DECISION: write and sync a unique sibling before rename so crashes never expose a partial body at its content-addressed path.
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(content, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      try { await rename(temporary, path); }
      catch (error) {
        if (!await verifyExisting()) throw error;
        await rm(temporary, { force: true });
      }
      if (!await verifyExisting()) throw new Error('Subtitle body disappeared immediately after atomic write');
      return { hash: contentHash, path };
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  });
}
function resolveBodyPath(path: string): string {
  const candidate = resolve(bodyRoot, path);
  const fromRoot = relative(bodyRoot, candidate);
  if (!fromRoot || fromRoot === '..' || fromRoot.startsWith(`..${sep}`)) throw new Error('Subtitle body path is outside the configured asset directory');
  return candidate;
}
export async function readBody(path: string): Promise<string> {
  const candidate = resolveBodyPath(path);
  const [realRoot, realCandidate] = await Promise.all([realpath(bodyRoot), realpath(candidate)]);
  const relativePath = relative(realRoot, realCandidate);
  if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${sep}`)) throw new Error('Subtitle body path resolves outside the configured asset directory');
  return readFile(realCandidate, 'utf8');
}
export function relativeBodyPath(path: string): string { return relative(bodyRoot, resolveBodyPath(path)); }
export function storeValidatedArtifact(input: { animeId: number; seasonId: string | null; episodeId: string; sourceLanguage: string; targetLanguage: string; sourceHash: string; model: string; configHash?: string; translationVersion?: string; sourceFormat: string; translatedFormat: string; sourcePath: string; translatedPath: string; score: number }): number {
  const configHash = input.configHash ?? `native:${input.model}`;
  const insert = database.prepare(`INSERT INTO subtitle_artifacts(anime_id,season_id,episode_id,source_language,target_language,source_hash,model,translation_version,config_hash,created_at,validation_status,source_format,translated_format,source_path,translated_path,score) VALUES(@animeId,@seasonId,@episodeId,@sourceLanguage,@targetLanguage,@sourceHash,@model,@version,@configHash,@createdAt,'validated',@sourceFormat,@translatedFormat,@sourcePath,@translatedPath,@score) ON CONFLICT(anime_id,episode_id,source_hash,target_language,config_hash) DO NOTHING`);
  insert.run({ ...input, configHash, version: input.translationVersion ?? process.env.SUBTITLE_TRANSLATION_VERSION ?? subtitleConfig.translationVersion, createdAt: nowIso() });
  const row = database.prepare(`SELECT id FROM subtitle_artifacts WHERE anime_id=? AND episode_id=? AND source_hash=? AND target_language=? AND config_hash=? AND validation_status='validated'`).get(input.animeId, input.episodeId, input.sourceHash, input.targetLanguage, configHash) as { id: number } | undefined;
  if (!row) throw new Error('Validated subtitle artifact insert did not persist');
  database.prepare(`INSERT INTO subs(title_id,number,path,source,status,translator) VALUES(?,?,?,'local-ai','final',?) ON CONFLICT(title_id,number) DO UPDATE SET path=excluded.path,source=excluded.source,status=excluded.status,translator=excluded.translator WHERE subs.status NOT IN ('final','qc')`).run(input.animeId, Number(input.episodeId), relativeBodyPath(input.translatedPath), input.model);
  return row.id;
}
export function updateValidatedArtifactBody(id: number, translatedPath: string, translatedFormat: string): void {
  const artifact = database.prepare(`SELECT anime_id,episode_id FROM subtitle_artifacts WHERE id=? AND validation_status='validated'`).get(id) as { anime_id: number; episode_id: string } | undefined;
  if (!artifact) throw new Error(`Validated subtitle artifact ${id} does not exist`);
  const transaction = database.transaction(() => {
    const updated = database.prepare(`UPDATE subtitle_artifacts SET translated_path=?,translated_format=? WHERE id=? AND validation_status='validated'`).run(translatedPath, translatedFormat, id);
    if (updated.changes !== 1) throw new Error(`Validated subtitle artifact ${id} changed while updating its body`);
    database.prepare(`UPDATE subs SET path=? WHERE title_id=? AND number=? AND source='local-ai' AND status IN ('final','qc')`).run(relativeBodyPath(translatedPath), artifact.anime_id, Number(artifact.episode_id));
  });
  transaction();
}
export function findCachedArtifact(sourceHash: string, target: string, configHash: string, version: string): Record<string, unknown> | undefined {
  return database.prepare(`SELECT * FROM subtitle_artifacts WHERE source_hash=? AND target_language=? AND config_hash=? AND translation_version=? AND validation_status='validated' ORDER BY id DESC LIMIT 1`).get(sourceHash, target, configHash, version) as Record<string, unknown> | undefined;
}
export function setGlossary(animeId: number, entries: Array<{ source: string; target: string; note?: string }>): void {
  const insert = database.prepare(`INSERT INTO subtitle_glossary(anime_id,source,target,note,created_at,updated_at) VALUES(@animeId,@source,@target,@note,@now,@now) ON CONFLICT(anime_id,source) DO UPDATE SET target=excluded.target,note=excluded.note,updated_at=excluded.updated_at`);
  const transaction = database.transaction(() => { for (const entry of entries) insert.run({ animeId, source: entry.source, target: entry.target, note: entry.note ?? '', now: nowIso() }); });
  transaction();
}
export function getGlossary(animeId: number): Array<{ source: string; target: string; note: string }> { return database.prepare('SELECT source,target,note FROM subtitle_glossary WHERE anime_id=? ORDER BY source').all(animeId) as Array<{ source: string; target: string; note: string }>; }
export function listArtifacts(animeId?: number, episodeId?: string): Array<Record<string, unknown>> {
  const clauses: string[] = ["validation_status='validated'"]; const values: unknown[] = [];
  if (animeId !== undefined) { clauses.push('anime_id=?'); values.push(animeId); }
  if (episodeId !== undefined) { clauses.push('episode_id=?'); values.push(episodeId); }
  return database.prepare(`SELECT * FROM subtitle_artifacts WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC`).all(...values) as Array<Record<string, unknown>>;
}
export function jobStats(): Record<string, unknown> {
  const counts = database.prepare('SELECT status,COUNT(*) AS count FROM subtitle_jobs GROUP BY status').all() as Array<{ status: string; count: number }>;
  const completed = database.prepare(`SELECT COUNT(*) AS count,AVG(CAST(json_extract(details,'$.elapsedMs') AS REAL)/1000.0) AS mean_seconds FROM subtitle_job_logs WHERE event='translation_completed'`).get() as { count: number; mean_seconds: number | null };
  const active = database.prepare(`SELECT id,anime_id,episode_id,status,attempts,updated_at,checkpoint FROM subtitle_jobs WHERE status IN ('DOWNLOADING','NORMALIZING','TRANSLATING','VALIDATING') ORDER BY updated_at`).all() as Array<{ id: number; anime_id: number; episode_id: string; status: string; attempts: number; updated_at: string; checkpoint: string }>;
  const progress = active.map(job => {
    try { const checkpoint = JSON.parse(job.checkpoint) as { translated?: Record<string, string>; elapsedMs?: number; totalCues?: number }; const translated = Object.keys(checkpoint.translated ?? {}).length; const total = Number(checkpoint.totalCues); return { translated, elapsedMs: Number(checkpoint.elapsedMs ?? 0), remaining: Number.isFinite(total) && total > 0 ? Math.max(0, total - translated) : null }; }
    catch { return { translated: 0, elapsedMs: 0, remaining: null }; }
  });
  const activeTranslatedCues = progress.reduce((sum, item) => sum + item.translated, 0);
  const activeElapsedMs = progress.reduce((sum, item) => sum + item.elapsedMs, 0);
  const activeCuesPerHour = activeElapsedMs > 0 ? activeTranslatedCues / (activeElapsedMs / 3_600_000) : null;
  const activeRemainingCues = progress.every(item => item.remaining !== null) ? progress.reduce((sum, item) => sum + (item.remaining ?? 0), 0) : null;
  const activeEpisodeRemainingSeconds = activeRemainingCues !== null && activeCuesPerHour && activeCuesPerHour > 0 ? activeRemainingCues / (activeCuesPerHour / 3600) : null;
  const recent = database.prepare(`SELECT COUNT(*) AS count FROM subtitle_job_logs WHERE event='translation_completed' AND created_at>=?`).get(new Date(Date.now() - 3600000).toISOString()) as { count: number };
  return { counts: Object.fromEntries(counts.map(row => [row.status, row.count])), completed: completed.count, meanSeconds: completed.mean_seconds, throughputPerHour: recent.count, active, activeTranslatedCues, activeCuesPerHour, activeEpisodeRemainingSeconds };
}
export function recentJobs(limit = 50): Array<Record<string, unknown>> { return database.prepare(`SELECT j.*,t.romaji,t.english FROM subtitle_jobs j LEFT JOIN titles t ON t.id=j.anime_id ORDER BY j.updated_at DESC LIMIT ?`).all(limit) as Array<Record<string, unknown>>; }
export function controlJob(id: number, action: 'retry' | 'skip'): void {
  if (action === 'retry') database.prepare(`UPDATE subtitle_jobs SET status='QUEUED',attempts=0,error=NULL,available_at=0,locked_at=NULL,updated_at=? WHERE id=? AND status IN ('FAILED','SKIPPED')`).run(nowIso(), id);
  else database.prepare(`UPDATE subtitle_jobs SET status='SKIPPED',locked_at=NULL,updated_at=? WHERE id=? AND status NOT IN ('COMPLETED','SKIPPED')`).run(nowIso(), id);
}
export function retryFailedJobs(): number {
  const transaction = database.transaction(() => {
    const result = database.prepare(`UPDATE subtitle_jobs SET status='QUEUED',attempts=0,error=NULL,available_at=0,locked_at=NULL,updated_at=? WHERE status='FAILED'`).run(nowIso());
    database.prepare('DELETE FROM subtitle_dead_letters WHERE job_id IN (SELECT id FROM subtitle_jobs WHERE status=\'QUEUED\')').run();
    return result.changes;
  });
  return transaction();
}
export function addDeadLetter(job: Job, reason: string): void {
  database.prepare('INSERT INTO subtitle_dead_letters(job_id,failed_at,attempts,reason) VALUES(?,?,?,?) ON CONFLICT(job_id) DO UPDATE SET failed_at=excluded.failed_at,attempts=excluded.attempts,reason=excluded.reason').run(job.id, nowIso(), job.attempts, reason);
}
export function deadLetters(limit = 50): Array<Record<string, unknown>> { return database.prepare('SELECT * FROM subtitle_dead_letters ORDER BY failed_at DESC LIMIT ?').all(limit) as Array<Record<string, unknown>>; }
export function existingBulgarian(animeId: number, episodeId: number): boolean {
  return Boolean(database.prepare(`SELECT 1 FROM subtitle_artifacts WHERE anime_id=? AND episode_id=? AND target_language='bg' AND validation_status='validated' UNION SELECT 1 FROM subs WHERE title_id=? AND number=? AND status IN ('qc','final') AND path IS NOT NULL LIMIT 1`).get(animeId, String(episodeId), animeId, episodeId));
}
export function closeSubtitleStorage(): void { database.close(); }
