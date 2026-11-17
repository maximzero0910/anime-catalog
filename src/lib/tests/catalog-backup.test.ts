import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { mkdtemp, mkdir, readFile, rm, writeFile, appendFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCatalogBackup, verifyCatalogBackup } from '../catalog-backup';

test('catalog backup is restorable and verifies database plus immutable subtitle assets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'anineko-backup-test-'));
  try {
    const databasePath = join(root, 'catalog.db');
    const assetDirectory = join(root, 'assets');
    await mkdir(assetDirectory);
    const db = new Database(databasePath);
    db.exec("CREATE TABLE titles(id INTEGER PRIMARY KEY, name TEXT NOT NULL); INSERT INTO titles VALUES(1, 'Test Anime');");
    db.close();
    await writeFile(join(assetDirectory, 'episode.vtt'), 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nЗдравей\n');
    const { directory } = await createCatalogBackup({ databasePath, assetDirectory, destinationDirectory: join(root, 'backups'), now: new Date('2026-01-02T03:04:05.000Z') });
    const manifest = await verifyCatalogBackup(directory);
    assert.equal(manifest.assets.length, 1);
    const restored = new Database(join(directory, 'catalog.db'), { readonly: true });
    assert.equal((restored.prepare('SELECT name FROM titles WHERE id=1').get() as { name: string }).name, 'Test Anime');
    restored.close();
    assert.match(await readFile(join(directory, 'assets', 'episode.vtt'), 'utf8'), /Здравей/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('backup verification rejects modified subtitle assets and backup targets inside source data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'anineko-backup-test-'));
  try {
    const databasePath = join(root, 'catalog.db');
    const assetDirectory = join(root, 'assets');
    await mkdir(assetDirectory);
    const db = new Database(databasePath); db.exec('CREATE TABLE titles(id INTEGER PRIMARY KEY);'); db.close();
    const backup = await createCatalogBackup({ databasePath, assetDirectory, destinationDirectory: join(root, 'backups'), now: new Date('2026-01-03T03:04:05.000Z') });
    await assert.rejects(createCatalogBackup({ databasePath, assetDirectory, destinationDirectory: join(assetDirectory, 'inside') }), /outside source/);
    await appendFile(join(backup.directory, 'catalog.db'), 'corruption');
    await assert.rejects(verifyCatalogBackup(backup.directory), /backup database/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('backup checks database subtitle references and rejects unmanifested files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'anineko-backup-reference-test-'));
  try {
    const databasePath = join(root, 'catalog.db');
    const assetDirectory = join(root, 'assets');
    await mkdir(assetDirectory);
    const source = join(assetDirectory, 'source.srt');
    const translated = join(assetDirectory, 'translated.vtt');
    await writeFile(source, 'source');
    await writeFile(translated, 'WEBVTT\n');
    const db = new Database(databasePath);
    db.exec(`CREATE TABLE subtitle_assets(storage_path TEXT NOT NULL); CREATE TABLE subtitle_artifacts(source_path TEXT NOT NULL, translated_path TEXT NOT NULL);`);
    db.prepare('INSERT INTO subtitle_assets VALUES(?)').run(translated);
    db.prepare('INSERT INTO subtitle_artifacts VALUES(?,?)').run(source, translated);
    db.close();

    const destinationDirectory = join(root, 'backups');
    const backup = await createCatalogBackup({ databasePath, assetDirectory, destinationDirectory, now: new Date('2026-01-04T03:04:05.000Z') });
    assert.equal((await verifyCatalogBackup(backup.directory)).assets.length, 2);
    await writeFile(join(backup.directory, 'assets', 'unexpected.txt'), 'unmanifested');
    await assert.rejects(() => verifyCatalogBackup(backup.directory), /unmanifested subtitle assets/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('backup creation refuses a database that references a missing subtitle body', async () => {
  const root = await mkdtemp(join(tmpdir(), 'anineko-backup-missing-reference-test-'));
  try {
    const databasePath = join(root, 'catalog.db');
    const assetDirectory = join(root, 'assets');
    const destinationDirectory = join(root, 'backups');
    await mkdir(assetDirectory);
    const db = new Database(databasePath);
    db.exec('CREATE TABLE subtitle_assets(storage_path TEXT NOT NULL)');
    db.prepare('INSERT INTO subtitle_assets VALUES(?)').run(join(assetDirectory, 'missing.vtt'));
    db.close();
    await assert.rejects(() => createCatalogBackup({ databasePath, assetDirectory, destinationDirectory }), /database-referenced subtitle asset/);
    assert.deepEqual(await readdir(destinationDirectory), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});
