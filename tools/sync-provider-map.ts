import Database from 'better-sqlite3';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const resolver = process.env.RESOLVER ?? 'http://127.0.0.1:3000';
const provider = process.env.CONSUMET_PROVIDER ?? 'anikoto';
const db = new Database(fileURLToPath(new URL('../data/catalog.db', import.meta.url)), { readonly: true });
const titles = db.prepare('SELECT id, slug, english, romaji FROM titles ORDER BY id').all() as Array<{ id: number; slug: string; english: string | null; romaji: string | null }>;
const mappings: Record<string, ProviderMapping> = {};
const normalize = (value: string) => value.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]/g, '');

for (const title of titles) {
  const query = title.english ?? title.romaji ?? String(title.id);
  const searchResponse = await fetch(`${resolver}/anime/${provider}/${encodeURIComponent(query)}`);
  if (!searchResponse.ok) throw new Error(`${provider} search failed for ${query}: ${searchResponse.status}`);
  const search = await searchResponse.json() as { results?: ProviderSearchResult[] };
  const candidate = search.results?.find(result => normalize(result.title) === normalize(query));
  if (!candidate) throw new Error(`No exact ${provider} title match for AniList ${title.id}: ${query}`);
  const infoResponse = await fetch(`${resolver}/anime/${provider}/info?id=${encodeURIComponent(candidate.id)}`);
  if (!infoResponse.ok) throw new Error(`${provider} info failed for ${candidate.id}: ${infoResponse.status}`);
  const info = await infoResponse.json() as ProviderInfo;
  if (!info.episodes?.length) throw new Error(`${provider} returned no episodes for ${candidate.id}`);
  mappings[String(title.id)] = {
    anilistId: title.id,
    slug: title.slug,
    provider,
    providerAnimeId: candidate.id,
    providerTitle: info.title,
    episodes: info.episodes.map(episode => ({ number: episode.number, providerEpisodeId: episode.id, title: episode.title ?? null })),
    mappedAt: new Date().toISOString(),
  };
  console.log(`Mapped AniList ${title.id} (${query}) -> ${provider}:${candidate.id} (${info.episodes.length} episodes)`);
}

db.close();
await writeFile(new URL('../data/provider-map.json', import.meta.url), `${JSON.stringify(mappings, null, 2)}\n`);

interface ProviderSearchResult { id: string; title: string; }
interface ProviderInfo { title: string; episodes?: Array<{ id: string; number: number; title?: string }>; }
interface ProviderMapping {
  anilistId: number;
  slug: string;
  provider: string;
  providerAnimeId: string;
  providerTitle: string;
  episodes: Array<{ number: number; providerEpisodeId: string; title: string | null }>;
  mappedAt: string;
}
