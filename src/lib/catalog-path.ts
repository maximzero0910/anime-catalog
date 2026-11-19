import { resolve } from 'node:path';

export interface CatalogPathEnvironment {
  CATALOG_DB_PATH?: string;
}

/** Resolve the single database path shared by the web process and all workers. */
export function catalogDatabasePath(
  environment: CatalogPathEnvironment = process.env,
  workingDirectory = process.cwd(),
): string {
  const configured = environment.CATALOG_DB_PATH?.trim();
  return resolve(workingDirectory, configured || 'data/catalog.db');
}
