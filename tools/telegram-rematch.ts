import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';

if (existsSync('.env')) loadEnvFile('.env');
const [{ matchTelegramMessage }, { telegramAdminMessages }] = await Promise.all([
  import('../src/lib/telegram/matching'), import('../src/lib/telegram/storage'),
]);
const database = new Database(resolve(process.env.CATALOG_DB_PATH ?? 'data/catalog.db'), { readonly: true });
const rows = database.prepare('SELECT m.* FROM telegram_messages m ORDER BY m.message_id').all() as Parameters<typeof matchTelegramMessage>[0][];
database.close();
const counts: Record<string, number> = {};
for (const row of rows) {
  const result = matchTelegramMessage(row);
  counts[result.status] = (counts[result.status] ?? 0) + 1;
}
console.info(JSON.stringify({ reprocessed: rows.length, counts, adminRowsAvailable: telegramAdminMessages().length }));

