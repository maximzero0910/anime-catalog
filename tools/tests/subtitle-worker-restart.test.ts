import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import test from 'node:test';

function startWorker(databasePath: string): { child: ChildProcess; output: string; errors: () => string; ready: Promise<void> } {
  const child = spawn(process.execPath, ['--import', 'tsx', 'tools/subtitles-worker.ts', '--watch'], {
    cwd: process.cwd(),
    env: { ...process.env, CATALOG_DB_PATH: databasePath, SUBTITLE_DATA_DIR: `${databasePath}.assets` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let stderr = '';
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolvePromise, rejectPromise) => { resolveReady = resolvePromise; rejectReady = rejectPromise; });
  const timer = setTimeout(() => rejectReady(new Error(`worker did not start: ${stderr}`)), 10_000);
  child.stdout.setEncoding('utf8').on('data', chunk => {
    output += chunk;
    if (output.includes('Online subtitle worker active:')) { clearTimeout(timer); resolveReady(); }
  });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  child.once('error', error => { clearTimeout(timer); rejectReady(error); });
  child.once('close', code => {
    if (code !== 0) { clearTimeout(timer); rejectReady(new Error(`worker exited before becoming ready (${code}): ${stderr}`)); }
  });
  return { child, get output() { return output; }, errors: () => stderr, ready };
}

async function stopWorker(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, 'close');
  child.kill('SIGTERM');
  const closeResult = await closed as [number | null, NodeJS.Signals | null];
  assert.equal(closeResult[0], 0);
}

test('SIGTERM checkpoints the worker and systemd-style restart returns to running', { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(`${tmpdir()}/subtitle-worker-restart-`);
  const databasePath = resolve(directory, 'catalog.db');
  const seed = new Database(databasePath);
  seed.pragma('journal_mode = WAL');
  seed.exec(`CREATE TABLE titles(id INTEGER PRIMARY KEY,romaji TEXT,english TEXT);
    CREATE TABLE episodes(title_id INTEGER NOT NULL,number INTEGER NOT NULL,PRIMARY KEY(title_id,number));
    CREATE TABLE subs(title_id INTEGER NOT NULL,number INTEGER NOT NULL,path TEXT,source TEXT,status TEXT DEFAULT 'draft',translator TEXT,PRIMARY KEY(title_id,number));`);
  seed.close();

  const workers: ChildProcess[] = [];
  try {
    const first = startWorker(databasePath);
    workers.push(first.child);
    await first.ready;
    const controls = new Database(databasePath);
    controls.prepare(`INSERT INTO subtitle_worker_settings(key,value,updated_at) VALUES('control','stopping',?) ON CONFLICT(key) DO UPDATE SET value='stopping',updated_at=excluded.updated_at`).run(new Date().toISOString());
    await new Promise(done => setTimeout(done, 2200));
    assert.equal(first.child.exitCode, null, 'operator stop should leave the controller available for resume');
    controls.prepare(`UPDATE subtitle_worker_settings SET value='running',updated_at=? WHERE key='control'`).run(new Date().toISOString());
    await new Promise(done => setTimeout(done, 2200));
    assert.equal(first.child.exitCode, null, 'resume should continue within the same worker process');
    controls.close();
    await stopWorker(first.child);

    const database = new Database(databasePath, { readonly: true });
    const control = database.prepare('SELECT value FROM subtitle_worker_settings WHERE key=?').get('control') as { value: string } | undefined;
    const heartbeat = database.prepare('SELECT state FROM app_worker_heartbeats WHERE worker=?').get('subtitle-worker') as { state: string } | undefined;
    database.close();
    assert.equal(control?.value, 'running');
    assert.equal(heartbeat?.state, 'stopped');

    const restarted = startWorker(databasePath);
    workers.push(restarted.child);
    await restarted.ready;
    const reopened = new Database(databasePath, { readonly: true });
    const nextHeartbeat = reopened.prepare('SELECT pid,state,heartbeat_at FROM app_worker_heartbeats WHERE worker=?').get('subtitle-worker') as { pid: number; state: string; heartbeat_at: number };
    reopened.close();
    assert.equal(nextHeartbeat.pid, restarted.child.pid);
    assert.equal(nextHeartbeat.state, 'running');
    assert.ok(Date.now() - nextHeartbeat.heartbeat_at < 10_000);
  } finally {
    for (const child of workers) {
      if (child.exitCode === null && child.signalCode === null) await stopWorker(child);
    }
    await rm(directory, { recursive: true, force: true });
  }
});
