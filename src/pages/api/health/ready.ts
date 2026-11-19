import { assertCatalogDatabaseReady } from '../../../lib/db';
import { readinessResponse } from '../../../lib/health-response';

export const prerender = false;

export function GET(): Response { return readinessResponse([assertCatalogDatabaseReady]); }
