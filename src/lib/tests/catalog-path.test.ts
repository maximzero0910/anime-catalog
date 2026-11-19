import assert from 'node:assert/strict';
import test from 'node:test';
import { catalogDatabasePath } from '../catalog-path';

test('all catalog stores resolve the same configured database path', () => {
  assert.equal(catalogDatabasePath({ CATALOG_DB_PATH: '/var/lib/anineko/catalog.db' }, '/srv/anineko'), '/var/lib/anineko/catalog.db');
  assert.equal(catalogDatabasePath({ CATALOG_DB_PATH: 'state/catalog.db' }, '/srv/anineko'), '/srv/anineko/state/catalog.db');
  assert.equal(catalogDatabasePath({}, '/srv/anineko'), '/srv/anineko/data/catalog.db');
  assert.equal(catalogDatabasePath({ CATALOG_DB_PATH: '   ' }, '/srv/anineko'), '/srv/anineko/data/catalog.db');
});
