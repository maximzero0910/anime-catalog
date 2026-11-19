import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, lstat, mkdir, readFile, readdir, rename, rm, stat, statfs, utimes, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';

export interface BackupOptions {
  databasePath: string;
  assetDirectory: string;
  destinationDirectory: string;
  now?: Date;
  minimumFreeBytes?: number;
  staleStagingMs?: number;
}

export interface BackupRetentionOptions {
  retainDays?: number;
  minimumCount?: number;
  now?: Date;
}

export interface BackupManifest {
  version: 1;
  createdAt: string;
  sourceAssetDirectory: string;
  database: { path: string; bytes: number; sha256: string };
  assets: Array<{ path: string; bytes: number; sha256: string }>;
}

function parseManifest(value: unknown): BackupManifest {
  if (!value || typeof value !== 'object') throw new Error('invalid backup manifest');
  const candidate = value as Partial<BackupManifest>;
  if (candidate.version !== 1 || typeof candidate.createdAt !== 'string' || !Number.isFinite(Date.parse(candidate.createdAt)) || typeof candidate.sourceAssetDirectory !== 'string' || !candidate.database || typeof candidate.database !== 'object' || !Array.isArray(candidate.assets)) throw new Error('unsupported backup manifest');
  const database = candidate.database as BackupManifest['database'];
  if (database.path !== 'catalog.db' || !Number.isSafeInteger(database.bytes) || database.bytes < 0 || !/^[a-f0-9]{64}$/.test(database.sha256)) throw new Error('invalid backup database manifest');
  for (const asset of candidate.assets) {
    if (!asset || typeof asset.path !== 'string' || !Number.isSafeInteger(asset.bytes) || asset.bytes < 0 || !/^[a-f0-9]{64}$/.test(asset.sha256)) throw new Error('invalid backup asset manifest');
  }
  return candidate as BackupManifest;
}

async function hashFile(path: string): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    bytes += chunk.length;
    hash.update(chunk);
  }
  return { bytes, sha256: hash.digest('hex') };
}

async function listFiles(root: string, relative = ''): Promise<string[]> {
  const current = join(root, relative);
  const output: string[] = [];
  for (const name of await readdir(current)) {
    const child = join(relative, name);
    const path = join(root, child);
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`backup refuses symbolic link: ${child}`);
    if (info.isDirectory()) output.push(...await listFiles(root, child));
    else if (info.isFile()) output.push(child);
    else throw new Error(`backup refuses unsupported filesystem entry: ${child}`);
  }
  return output.sort();
}

async function cleanStaleStagingDirectories(destination: string, now: Date, staleAfterMs: number): Promise<number> {
  let removed = 0;
  const cutoff = now.getTime() - staleAfterMs;
  for (const name of await readdir(destination)) {
    if (!/^\.anineko-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-\d+\.partial$/.test(name)) continue;
    const path = join(destination, name);
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || info.mtimeMs >= cutoff) continue;
    await rm(path, { recursive: true, force: false });
    removed++;
  }
  return removed;
}

export async function createCatalogBackup(options: BackupOptions): Promise<{ directory: string; manifest: BackupManifest }> {
  const source = resolve(options.databasePath);
  const assets = resolve(options.assetDirectory);
  const destination = resolve(options.destinationDirectory);
  if (destination === source || destination.startsWith(`${source}/`) || destination === assets || destination.startsWith(`${assets}/`)) {
    throw new Error('backup destination must be outside source database and asset paths');
  }
  const databaseStat = await stat(source);
  if (!databaseStat.isFile()) throw new Error('catalog database is not a regular file');
  const assetStat = await stat(assets);
  if (!assetStat.isDirectory()) throw new Error('subtitle asset path is not a directory');
  const sourceAssets = await listFiles(assets);
  let sourceAssetBytes = 0;
  for (const path of sourceAssets) sourceAssetBytes += (await stat(join(assets, path))).size;
  let walBytes = 0;
  try { walBytes = (await stat(`${source}-wal`)).size; } catch { /* A WAL file is not required when SQLite is checkpointed. */ }
  const minimumFreeBytes = options.minimumFreeBytes ?? 2 * 1024 * 1024 * 1024;
  const staleStagingMs = options.staleStagingMs ?? 24 * 60 * 60 * 1000;
  if (!Number.isSafeInteger(minimumFreeBytes) || minimumFreeBytes < 0) throw new Error('minimum backup free-space reserve must be a non-negative integer');
  if (!Number.isSafeInteger(staleStagingMs) || staleStagingMs < 60_000) throw new Error('stale staging age must be at least one minute');
  const stamp = (options.now ?? new Date()).toISOString().replace(/[:.]/g, '-');
  await mkdir(destination, { recursive: true });
  await cleanStaleStagingDirectories(destination, options.now ?? new Date(), staleStagingMs);
  const filesystem = await statfs(destination);
  const freeBytes = filesystem.bavail * filesystem.bsize;
  const estimatedBytes = databaseStat.size + walBytes + sourceAssetBytes;
  if (!Number.isSafeInteger(freeBytes) || freeBytes < estimatedBytes + minimumFreeBytes) {
    throw new Error(`backup destination has insufficient free space: available=${freeBytes}, estimated=${estimatedBytes}, required reserve=${minimumFreeBytes}`);
  }
  const finalDirectory = join(destination, `anineko-${stamp}`);
  const staging = join(destination, `.${basename(finalDirectory)}-${process.pid}.partial`);
  await mkdir(staging, { recursive: false });
  try {
    const db = new Database(source, { readonly: true, fileMustExist: true, timeout: 5000 });
    try {
      const backup = (db as Database.Database & { backup(path: string): Promise<void> }).backup;
      await backup.call(db, join(staging, 'catalog.db'));
    } finally { db.close(); }
    const verify = new Database(join(staging, 'catalog.db'), { readonly: true, fileMustExist: true });
    try {
      const integrity = verify.pragma('integrity_check') as Array<{ integrity_check: string }>;
      if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') throw new Error('backup database integrity check failed');
      if ((verify.pragma('foreign_key_check') as unknown[]).length) throw new Error('backup database foreign key check failed');
    } finally { verify.close(); }

    const copiedAssets: BackupManifest['assets'] = [];
    for (const relative of sourceAssets) {
      const target = join(staging, 'assets', relative);
      await mkdir(join(target, '..'), { recursive: true });
      await cp(join(assets, relative), target, { errorOnExist: true, force: false });
      copiedAssets.push({ path: relative, ...await hashFile(target) });
    }
    await mkdir(join(staging, 'assets'), { recursive: true });
    const manifest: BackupManifest = {
      version: 1,
      createdAt: (options.now ?? new Date()).toISOString(),
      sourceAssetDirectory: assets,
      database: { path: 'catalog.db', ...await hashFile(join(staging, 'catalog.db')) },
      assets: copiedAssets,
    };
    await writeFile(join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await verifyCatalogBackup(staging);
    await rename(staging, finalDirectory);
    return { directory: finalDirectory, manifest };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

export async function pruneCatalogBackups(directory: string, options: BackupRetentionOptions = {}): Promise<{ removed: number; removedBytes: number; retained: number }> {
  const root = resolve(directory);
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('backup retention root must be a real directory');
  const retainDays = options.retainDays ?? 30;
  const minimumCount = options.minimumCount ?? 14;
  if (!Number.isSafeInteger(retainDays) || retainDays < 1 || retainDays > 3650) throw new Error('backup retention days must be between 1 and 3650');
  if (!Number.isSafeInteger(minimumCount) || minimumCount < 1 || minimumCount > 1000) throw new Error('minimum retained backups must be between 1 and 1000');

  const backups: Array<{ path: string; createdAt: number; bytes: number }> = [];
  for (const name of await readdir(root)) {
    if (!/^anineko-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/.test(name)) continue;
    const path = join(root, name);
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) continue;
    try {
      const manifest = parseManifest(JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8')) as unknown);
      const bytes = manifest.database.bytes + manifest.assets.reduce((sum, asset) => sum + asset.bytes, 0);
      backups.push({ path, createdAt: Date.parse(manifest.createdAt), bytes });
    } catch {
      // Preserve incomplete or unrecognized directories for manual inspection.
    }
  }
  backups.sort((left, right) => right.createdAt - left.createdAt || right.path.localeCompare(left.path));
  const cutoff = (options.now ?? new Date()).getTime() - retainDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  let removedBytes = 0;
  for (const [index, backup] of backups.entries()) {
    if (index < minimumCount || backup.createdAt >= cutoff) continue;
    const resolved = resolve(backup.path);
    if (!resolved.startsWith(`${root}${sep}`)) continue;
    await rm(resolved, { recursive: true, force: false });
    removed++;
    removedBytes += backup.bytes;
  }
  return { removed, removedBytes, retained: backups.length - removed };
}

export async function verifyCatalogBackup(directory: string): Promise<BackupManifest> {
  const root = resolve(directory);
  const manifest = parseManifest(JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) as unknown);
  const dbPath = join(root, manifest.database.path);
  if (JSON.stringify(await hashFile(dbPath)) !== JSON.stringify({ bytes: manifest.database.bytes, sha256: manifest.database.sha256 })) throw new Error('backup database checksum mismatch');
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const integrity = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') throw new Error('backup database integrity check failed');
    if ((db.pragma('foreign_key_check') as unknown[]).length) throw new Error('backup database foreign key check failed');
  } finally { db.close(); }
  for (const asset of manifest.assets) {
    if (asset.path.startsWith('/') || asset.path.split(/[\\/]/).includes('..')) throw new Error('invalid asset path in backup manifest');
    const assetPath = join(root, 'assets', asset.path);
    const real = await lstat(assetPath);
    if (!real.isFile() || JSON.stringify(await hashFile(assetPath)) !== JSON.stringify({ bytes: asset.bytes, sha256: asset.sha256 })) throw new Error(`backup asset verification failed: ${asset.path}`);
  }
  const listedAssets = new Set(manifest.assets.map(asset => asset.path));
  const diskAssets = await listFiles(join(root, 'assets'));
  if (diskAssets.length !== listedAssets.size || diskAssets.some(path => !listedAssets.has(path))) throw new Error('backup contains missing or unmanifested subtitle assets');

  const referenceDb = new Database(dbPath, { readonly: true, fileMustExist: true });
  let referencedPaths: string[] = [];
  try {
    const tables = new Set((referenceDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(row => row.name));
    if (tables.has('subtitle_assets')) referencedPaths.push(...(referenceDb.prepare('SELECT storage_path AS path FROM subtitle_assets').all() as Array<{ path: string }>).map(row => row.path));
    if (tables.has('subtitle_artifacts')) referencedPaths.push(...(referenceDb.prepare('SELECT source_path AS path FROM subtitle_artifacts UNION SELECT translated_path AS path FROM subtitle_artifacts').all() as Array<{ path: string }>).map(row => row.path));
  } finally { referenceDb.close(); }
  for (const sourcePath of referencedPaths) {
    const fullPath = resolve(manifest.sourceAssetDirectory, sourcePath);
    const relativePath = relative(resolve(manifest.sourceAssetDirectory), fullPath);
    if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${sep}`) || !listedAssets.has(relativePath)) {
      throw new Error(`backup is missing a database-referenced subtitle asset: ${sourcePath}`);
    }
  }
  return manifest;
}
