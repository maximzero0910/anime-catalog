import type Database from 'better-sqlite3';

export function createSqliteLease(database: Database.Database, name: string) {
  if (!/^[a-z][a-z0-9_-]{1,63}$/.test(name)) throw new Error('invalid lease name');
  database.exec(`CREATE TABLE IF NOT EXISTS app_leases (
    name TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  )`);
  const acquire = database.prepare(`INSERT INTO app_leases(name,owner,expires_at) VALUES(?,?,?)
    ON CONFLICT(name) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at
    WHERE app_leases.expires_at<=? OR app_leases.owner=?`);
  const renew = database.prepare('UPDATE app_leases SET expires_at=? WHERE name=? AND owner=? AND expires_at>?');
  const release = database.prepare('DELETE FROM app_leases WHERE name=? AND owner=?');
  const active = database.prepare('SELECT 1 AS active FROM app_leases WHERE name=? AND expires_at>?');
  return {
    acquire(owner: string, now = Date.now(), ttlMs = 120_000): boolean {
      if (!owner || owner.length > 160 || !Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 60 * 60_000) throw new Error('invalid lease request');
      return acquire.run(name, owner, now + ttlMs, now, owner).changes === 1;
    },
    renew(owner: string, now = Date.now(), ttlMs = 120_000): boolean {
      if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 60 * 60_000) throw new Error('invalid lease duration');
      return renew.run(now + ttlMs, name, owner, now).changes === 1;
    },
    isActive(now = Date.now()): boolean { return Boolean(active.get(name, now)); },
    release(owner: string): boolean { return release.run(name, owner).changes === 1; },
  };
}
