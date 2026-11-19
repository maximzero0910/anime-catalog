import { createCatalogBackup, pruneCatalogBackups, verifyCatalogBackup } from '../src/lib/catalog-backup';
import { catalogDatabasePath } from '../src/lib/catalog-path';

const args = process.argv.slice(2);
const option = (name: string, fallback: number): number => {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(args[index + 1]);
  if (!Number.isSafeInteger(value)) throw new Error(`${name} requires an integer value`);
  return value;
};
if (args[0] === '--verify' && args[1]) {
  const manifest = await verifyCatalogBackup(args[1]);
  console.info({ event: 'catalog_backup_verified', directory: args[1], bytes: manifest.database.bytes, assets: manifest.assets.length });
} else if (!args[0]) {
  console.error('Usage: npm run catalog:backup -- <destination-directory> [--prune] [--retain-days N] [--minimum-count N] [--minimum-free-mib N] | --verify <backup-directory>');
  process.exitCode = 2;
} else {
  const destinationDirectory = args[0];
  const minimumFreeMiB = option('--minimum-free-mib', 2048);
  if (minimumFreeMiB < 0 || minimumFreeMiB > 1_048_576) throw new Error('--minimum-free-mib must be between 0 and 1048576');
  const result = await createCatalogBackup({
    databasePath: catalogDatabasePath(),
    assetDirectory: process.env.SUBTITLE_DATA_DIR ?? 'data/subtitles',
    destinationDirectory,
    minimumFreeBytes: minimumFreeMiB * 1024 * 1024,
  });
  await verifyCatalogBackup(result.directory);
  const retention = args.includes('--prune') ? await pruneCatalogBackups(destinationDirectory, { retainDays: option('--retain-days', 30), minimumCount: option('--minimum-count', 14) }) : undefined;
  console.info({ event: 'catalog_backup_verified', directory: result.directory, bytes: result.manifest.database.bytes, assets: result.manifest.assets.length, ...(retention ? { retention } : {}) });
}
