import Database from 'better-sqlite3';
import { catalogDatabasePath } from './catalog-path';

export interface WorkerHeartbeatRow {
  worker: string;
  pid: number;
  started_at: number;
  heartbeat_at: number;
  state: 'running' | 'stopped';
}

export function createWorkerHeartbeatStore(database: Database.Database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS app_worker_heartbeats (
      worker TEXT PRIMARY KEY,
      pid INTEGER NOT NULL,
      started_at INTEGER NOT NULL,
      heartbeat_at INTEGER NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('running','stopped'))
    );
  `);
  const upsert = database.prepare(`INSERT INTO app_worker_heartbeats(worker,pid,started_at,heartbeat_at,state)
    VALUES(@worker,@pid,@started,@heartbeat,'running')
    ON CONFLICT(worker) DO UPDATE SET pid=excluded.pid,started_at=excluded.started_at,heartbeat_at=excluded.heartbeat_at,state='running'`);
  const stop = database.prepare(`UPDATE app_worker_heartbeats SET heartbeat_at=?,state='stopped' WHERE worker=? AND pid=?`);
  const select = database.prepare('SELECT worker,pid,started_at,heartbeat_at,state FROM app_worker_heartbeats ORDER BY worker');
  let processStartedAt = 0;

  return {
    beat(worker: string, at = Date.now(), pid = process.pid): void {
      if (!/^[a-z][a-z0-9-]{1,40}$/.test(worker)) throw new Error('invalid worker name');
      if (!processStartedAt) processStartedAt = at;
      upsert.run({ worker, pid, started: processStartedAt, heartbeat: at });
    },
    stopped(worker: string, at = Date.now(), pid = process.pid): void { stop.run(at, worker, pid); },
    list(now = Date.now(), staleAfterMs = 30_000): Array<WorkerHeartbeatRow & { ageMs: number; healthy: boolean }> {
      return (select.all() as WorkerHeartbeatRow[]).map(row => {
        const ageMs = Math.max(0, now - row.heartbeat_at);
        return { ...row, ageMs, healthy: row.state === 'running' && ageMs <= staleAfterMs };
      });
    },
  };
}

let heartbeatStore: ReturnType<typeof createWorkerHeartbeatStore> | undefined;
function store(): ReturnType<typeof createWorkerHeartbeatStore> {
  if (!heartbeatStore) {
    const database = new Database(catalogDatabasePath(), { timeout: 5000 });
    database.pragma('journal_mode = WAL');
    database.pragma('busy_timeout = 5000');
    heartbeatStore = createWorkerHeartbeatStore(database);
  }
  return heartbeatStore;
}

export function recordWorkerHeartbeat(worker: string, at?: number): void { store().beat(worker, at); }
export function markWorkerStopped(worker: string, at?: number): void { store().stopped(worker, at); }
export function workerHeartbeats(now?: number, staleAfterMs?: number): Array<WorkerHeartbeatRow & { ageMs: number; healthy: boolean }> {
  return store().list(now, staleAfterMs);
}

export function startWorkerHeartbeat(worker: string, intervalMs = 10_000): () => void {
  recordWorkerHeartbeat(worker);
  const timer = setInterval(() => {
    try { recordWorkerHeartbeat(worker); }
    catch (error) {
      // DECISION: a transient heartbeat write must not crash useful work; the timestamp then naturally ages into a visible stale state.
      console.error({ event: 'worker_heartbeat_failed', worker, reason: error instanceof Error ? error.name : 'unknown' });
    }
  }, intervalMs);
  timer.unref();
  return () => {
    clearInterval(timer);
    try { markWorkerStopped(worker); }
    catch (error) { console.error({ event: 'worker_heartbeat_stop_failed', worker, reason: error instanceof Error ? error.name : 'unknown' }); }
  };
}
