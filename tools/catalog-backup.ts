import { createCatalogBackup, verifyCatalogBackup } from '../src/lib/catalog-backup';
import { catalogDatabasePath } from '../src/lib/catalog-path';

const args = process.argv.slice(2);
if (args[0] === '--verify' && args[1]) {
  const manifest = await verifyCatalogBackup(args[1]);
  console.info({ event: 'catalog_backup_verified', directory: args[1], bytes: manifest.database.bytes, assets: manifest.assets.length });
} else if (!args[0]) {
  console.error('Usage: npm run catalog:backup -- <destination-directory> | --verify <backup-directory>');
  process.exitCode = 2;
} else {
  const result = await createCatalogBackup({
    databasePath: catalogDatabasePath(),
    assetDirectory: process.env.SUBTITLE_DATA_DIR ?? 'data/subtitles',
    destinationDirectory: args[0],
  });
  await verifyCatalogBackup(result.directory);
  console.info({ event: 'catalog_backup_verified', directory: result.directory, bytes: result.manifest.database.bytes, assets: result.manifest.assets.length });
}
