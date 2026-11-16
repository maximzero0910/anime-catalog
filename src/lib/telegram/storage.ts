import './config';
import Database from 'better-sqlite3';
import { resolve } from 'node:path';

const database = new Database(resolve(process.env.CATALOG_DB_PATH ?? 'data/catalog.db'), { timeout: 5000 });
database.pragma('journal_mode = WAL');
database.pragma('busy_timeout = 5000');
database.exec(`
CREATE TABLE IF NOT EXISTS telegram_sync_state (
  id INTEGER PRIMARY KEY CHECK(id=1), channel TEXT NOT NULL DEFAULT '', channel_id TEXT NOT NULL DEFAULT '', channel_name TEXT NOT NULL DEFAULT '',
  checkpoint INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'idle', progress INTEGER NOT NULL DEFAULT 0,
  last_success TEXT, last_error TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT OR IGNORE INTO telegram_sync_state(id) VALUES(1);
CREATE TABLE IF NOT EXISTS telegram_messages (
  channel_id TEXT NOT NULL, message_id INTEGER NOT NULL, caption TEXT NOT NULL DEFAULT '', filename TEXT NOT NULL DEFAULT '',
  mime_type TEXT NOT NULL DEFAULT 'video/mp4', duration_seconds REAL, file_size INTEGER NOT NULL DEFAULT 0,
  document_id TEXT, access_hash TEXT, file_reference TEXT, dc_id INTEGER, media_json TEXT NOT NULL DEFAULT '{}',
  seen_at TEXT NOT NULL, PRIMARY KEY(channel_id,message_id)
);
CREATE TABLE IF NOT EXISTS telegram_episode_matches (
  channel_id TEXT NOT NULL, message_id INTEGER NOT NULL, anime_id INTEGER, episode_number INTEGER, season_number INTEGER,
  confidence REAL NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'UNMATCHED' CHECK(status IN ('MATCHED','AMBIGUOUS','UNMATCHED','DUPLICATE','FAILED')),
  reason TEXT NOT NULL DEFAULT '', candidates TEXT NOT NULL DEFAULT '[]', hardsub_language TEXT NOT NULL DEFAULT 'bg',
  verified INTEGER NOT NULL DEFAULT 0, primary_match INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL,
  PRIMARY KEY(channel_id,message_id), FOREIGN KEY(channel_id,message_id) REFERENCES telegram_messages(channel_id,message_id)
);
CREATE TABLE IF NOT EXISTS telegram_media_failures (
  channel_id TEXT NOT NULL, message_id INTEGER NOT NULL, failure_count INTEGER NOT NULL DEFAULT 1, last_error TEXT NOT NULL,
  updated_at TEXT NOT NULL, PRIMARY KEY(channel_id,message_id), FOREIGN KEY(channel_id,message_id) REFERENCES telegram_messages(channel_id,message_id)
);
CREATE INDEX IF NOT EXISTS telegram_match_lookup ON telegram_episode_matches(anime_id,episode_number,status,verified);
CREATE UNIQUE INDEX IF NOT EXISTS telegram_episode_primary_unique ON telegram_episode_matches(anime_id,COALESCE(season_number,0),episode_number) WHERE primary_match=1 AND status='MATCHED';
CREATE TABLE IF NOT EXISTS telegram_title_aliases (anime_id INTEGER NOT NULL, alias TEXT NOT NULL, normalized TEXT NOT NULL, PRIMARY KEY(anime_id,normalized));
DROP INDEX IF EXISTS telegram_episode_primary_unique;
CREATE UNIQUE INDEX telegram_episode_primary_unique ON telegram_episode_matches(anime_id,episode_number) WHERE primary_match=1 AND status='MATCHED';
`);

export interface TelegramMessageRow {
  channel_id: string; message_id: number; caption: string; filename: string; mime_type: string; duration_seconds: number | null;
  file_size: number; document_id: string | null; access_hash: string | null; file_reference: string | null; dc_id: number | null; media_json: string;
}
export interface TelegramMatchRow {
  channel_id: string; message_id: number; anime_id: number | null; episode_number: number | null; season_number: number | null;
  confidence: number; status: 'MATCHED'|'AMBIGUOUS'|'UNMATCHED'|'DUPLICATE'|'FAILED'; reason: string; candidates: string;
  hardsub_language: string; verified: number; primary_match: number;
}
const now = () => new Date().toISOString();

export function saveTelegramMessage(row: Omit<TelegramMessageRow, 'seen_at'>): void {
  database.prepare(`INSERT INTO telegram_messages(channel_id,message_id,caption,filename,mime_type,duration_seconds,file_size,document_id,access_hash,file_reference,dc_id,media_json,seen_at)
  VALUES(@channel_id,@message_id,@caption,@filename,@mime_type,@duration_seconds,@file_size,@document_id,@access_hash,@file_reference,@dc_id,@media_json,@seen_at)
  ON CONFLICT(channel_id,message_id) DO UPDATE SET caption=excluded.caption,filename=excluded.filename,mime_type=excluded.mime_type,duration_seconds=excluded.duration_seconds,file_size=excluded.file_size,document_id=excluded.document_id,access_hash=excluded.access_hash,file_reference=excluded.file_reference,dc_id=excluded.dc_id,media_json=excluded.media_json,seen_at=excluded.seen_at`).run({ ...row, seen_at: now() });
}
export function getTelegramMessage(messageId: number, channelId?: string): TelegramMessageRow | undefined {
  return (channelId ? database.prepare('SELECT * FROM telegram_messages WHERE channel_id=? AND message_id=?') : database.prepare('SELECT * FROM telegram_messages WHERE message_id=? ORDER BY seen_at DESC LIMIT 1')).get(...(channelId ? [channelId, messageId] : [messageId])) as TelegramMessageRow | undefined;
}
export function saveTelegramMatch(input: Omit<TelegramMatchRow, 'updated_at'>): void {
  database.prepare(`INSERT INTO telegram_episode_matches(channel_id,message_id,anime_id,episode_number,season_number,confidence,status,reason,candidates,hardsub_language,verified,primary_match,updated_at)
  VALUES(@channel_id,@message_id,@anime_id,@episode_number,@season_number,@confidence,@status,@reason,@candidates,@hardsub_language,@verified,@primary_match,@updated_at)
  ON CONFLICT(channel_id,message_id) DO UPDATE SET anime_id=excluded.anime_id,episode_number=excluded.episode_number,season_number=excluded.season_number,confidence=excluded.confidence,status=excluded.status,reason=excluded.reason,candidates=excluded.candidates,hardsub_language=excluded.hardsub_language,verified=excluded.verified,primary_match=excluded.primary_match,updated_at=excluded.updated_at`).run({ ...input, updated_at: now() });
}
export function getTelegramEpisode(animeId: number, episode: number): (TelegramMessageRow & TelegramMatchRow) | undefined {
  return database.prepare(`SELECT m.*,x.* FROM telegram_episode_matches x JOIN telegram_messages m USING(channel_id,message_id)
  WHERE x.anime_id=? AND x.episode_number=? AND x.status='MATCHED' AND x.verified=1 AND x.primary_match=1 LIMIT 1`).get(animeId, episode) as (TelegramMessageRow & TelegramMatchRow) | undefined;
}
export function getPlayableTelegramMessage(messageId: number): (TelegramMessageRow & TelegramMatchRow) | undefined {
  return database.prepare(`SELECT m.*,x.* FROM telegram_episode_matches x JOIN telegram_messages m USING(channel_id,message_id)
  WHERE x.message_id=? AND x.status='MATCHED' AND x.verified=1 AND x.primary_match=1 LIMIT 1`).get(messageId) as (TelegramMessageRow & TelegramMatchRow) | undefined;
}
export function matchedTelegramEpisodes(animeId?: number): Array<Record<string, unknown>> {
  return (animeId === undefined ? database.prepare(`SELECT m.*,x.* FROM telegram_episode_matches x JOIN telegram_messages m USING(channel_id,message_id) ORDER BY x.updated_at DESC`).all() : database.prepare(`SELECT m.*,x.* FROM telegram_episode_matches x JOIN telegram_messages m USING(channel_id,message_id) WHERE x.anime_id=? ORDER BY x.episode_number`).all(animeId)) as Array<Record<string, unknown>>;
}
export function telegramAdminMessages(): Array<Record<string, unknown>> {
  return database.prepare(`SELECT m.channel_id,m.message_id,m.caption,m.filename,m.duration_seconds,m.file_size,
    x.anime_id,x.episode_number,x.season_number,x.confidence,x.status,x.reason,x.candidates,x.verified,x.primary_match,
    COALESCE(f.failure_count,0) AS media_failure_count,f.last_error AS media_last_error
    FROM telegram_episode_matches x JOIN telegram_messages m USING(channel_id,message_id)
    LEFT JOIN telegram_media_failures f USING(channel_id,message_id) ORDER BY x.updated_at DESC LIMIT 300`).all() as Array<Record<string, unknown>>;
}
export function telegramStats(): Record<string, unknown> {
  const counts = database.prepare(`SELECT COUNT(*) discovered,COALESCE(SUM(status='MATCHED'),0) matched,COALESCE(SUM(status='UNMATCHED'),0) unmatched,COALESCE(SUM(status='AMBIGUOUS'),0) ambiguous,COALESCE(SUM(status='DUPLICATE'),0) duplicates,COALESCE(SUM(status='FAILED'),0) failed FROM telegram_episode_matches`).get() as Record<string, number>;
  const state = database.prepare('SELECT * FROM telegram_sync_state WHERE id=1').get() as Record<string, unknown>;
  const configuredChannel = process.env.TG_CHANNEL ?? process.env.TELEGRAM_CHANNEL ?? '';
  const failedMediaReferences = Number((database.prepare('SELECT COUNT(*) AS count FROM telegram_media_failures').get() as { count: number }).count);
  const session = process.env.TG_SESSION ?? process.env.TELEGRAM_SESSION ?? '';
  const apiId = Number(process.env.TG_API_ID ?? process.env.TELEGRAM_API_ID);
  const apiHash = process.env.TG_API_HASH ?? process.env.TELEGRAM_API_HASH ?? '';
  return { ...state, ...counts, failedMediaReferences, channel: state.channel || configuredChannel, channel_name: state.channel_name || configuredChannel, configuredChannel, connectionConfigured: Boolean(Number.isSafeInteger(apiId) && apiId > 0 && apiHash.length >= 32 && session.length >= 50 && !/(your_|placeholder|replace_me)/i.test(session) && configuredChannel) };
}
export function recordTelegramMediaFailure(messageId: number, error: string): void {
  const row = getTelegramMessage(messageId);
  if (!row) return;
  database.prepare(`INSERT INTO telegram_media_failures(channel_id,message_id,failure_count,last_error,updated_at) VALUES(?,?,1,?,?)
    ON CONFLICT(channel_id,message_id) DO UPDATE SET failure_count=failure_count+1,last_error=excluded.last_error,updated_at=excluded.updated_at`).run(row.channel_id, messageId, error.slice(0, 1000), now());
}
export function clearTelegramMediaFailure(messageId: number): void { database.prepare('DELETE FROM telegram_media_failures WHERE message_id=?').run(messageId); }
export function telegramSyncCheckpoint(): number { return Number((database.prepare('SELECT checkpoint FROM telegram_sync_state WHERE id=1').get() as { checkpoint: number }).checkpoint); }
export function updateTelegramSyncState(values: { channel?: string; channelId?: string; channelName?: string; checkpoint?: number; status?: string; progress?: number; lastSuccess?: string | null; lastError?: string | null }): void {
  const current = database.prepare('SELECT * FROM telegram_sync_state WHERE id=1').get() as Record<string, unknown>;
  database.prepare(`UPDATE telegram_sync_state SET channel=@channel,channel_id=@channel_id,channel_name=@channel_name,checkpoint=@checkpoint,status=@status,progress=@progress,last_success=@last_success,last_error=@last_error,updated_at=@updated_at WHERE id=1`).run({
    channel: values.channel ?? current.channel ?? '', channel_id: values.channelId ?? current.channel_id ?? '', channel_name: values.channelName ?? current.channel_name ?? '', checkpoint: values.checkpoint ?? Number(current.checkpoint ?? 0), status: values.status ?? String(current.status ?? 'idle'), progress: values.progress ?? Number(current.progress ?? 0), last_success: values.lastSuccess === undefined ? current.last_success ?? null : values.lastSuccess, last_error: values.lastError === undefined ? current.last_error ?? null : values.lastError, updated_at: now(),
  });
}
export function associateTelegramMessage(channelId: string, messageId: number, animeId: number, episode: number, season: number | null, verified: boolean): void {
  if (!database.prepare('SELECT 1 FROM titles WHERE id=?').get(animeId)) throw new Error(`Anime ${animeId} is not in the catalog`);
  if (!Number.isSafeInteger(episode) || episode < 1 || (season !== null && (!Number.isSafeInteger(season) || season < 1))) throw new Error('Invalid season or episode number');
  const row = getTelegramMessage(messageId, channelId);
  if (!row) throw new Error('Telegram post is not indexed');
  database.prepare('INSERT INTO episodes(title_id,number,duration,filler) VALUES(?,?,?,0) ON CONFLICT(title_id,number) DO UPDATE SET duration=COALESCE(episodes.duration,excluded.duration)').run(animeId, episode, row.duration_seconds);
  database.prepare('UPDATE titles SET episodes=MAX(COALESCE(episodes,0),?) WHERE id=?').run(episode, animeId);
  saveTelegramMatch({ channel_id: channelId, message_id: messageId, anime_id: animeId, episode_number: episode, season_number: season, confidence: 1, status: 'MATCHED', reason: 'Manually associated by administrator', candidates: '[]', hardsub_language: 'bg', verified: verified ? 1 : 0, primary_match: verified ? 1 : 0 });
}
export function rejectTelegramMatch(channelId: string, messageId: number): void {
  database.prepare(`UPDATE telegram_episode_matches SET status='UNMATCHED',verified=0,primary_match=0,reason='Association explicitly rejected by administrator',updated_at=? WHERE channel_id=? AND message_id=?`).run(now(), channelId, messageId);
}
export function upsertTelegramAlias(animeId: number, alias: string): void {
  const normalized = alias.toLocaleLowerCase().normalize('NFKD').replace(/\p{Diacritic}/gu, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  if (!normalized || alias.length > 200) throw new Error('Invalid alias');
  database.prepare('INSERT INTO telegram_title_aliases(anime_id,alias,normalized) VALUES(?,?,?) ON CONFLICT(anime_id,normalized) DO NOTHING').run(animeId, alias.trim(), normalized);
}
export function telegramAliases(): Array<{ anime_id: number; alias: string }> { return database.prepare('SELECT anime_id,alias FROM telegram_title_aliases').all() as Array<{ anime_id: number; alias: string }>; }

