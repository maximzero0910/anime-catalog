import Database from 'better-sqlite3';
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
const db = new Database(fileURLToPath(new URL('../data/catalog.db', import.meta.url)), { readonly: true, fileMustExist: true });
const rows = db.prepare('SELECT slug, english, romaji, native, title_bg, year, format, cover, score FROM titles ORDER BY score DESC').all() as Array<{ slug: string; english: string | null; romaji: string | null; native: string | null; title_bg: string | null; year: number | null; format: string | null; cover: string | null; score: number | null }>;
await mkdir(new URL('../public/', import.meta.url), { recursive: true });
await writeFile(new URL('../public/search.json', import.meta.url), JSON.stringify(rows.map(({ slug, english, romaji, ...rest }) => ({ slug, title: english ?? romaji, ...rest })), null, 2) + '\n');
db.close();
