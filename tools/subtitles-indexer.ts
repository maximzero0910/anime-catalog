import { getEpisodes, getTitleById, getTitles } from '../src/lib/db';
import { subtitleMatchScore, indexSubtitleCandidate, registerAnimeAliases } from '../src/lib/subtitles/index';
import { AniMaBgCatalogProvider, crawlAnimeBgCatalog, subtitleIndexProviders, type SubtitleAnimeIds } from '../src/lib/subtitles/index-providers';
import { claimSubtitleIndexJobs, enqueueSubtitleIndexJob, finishSubtitleIndexJob, indexedSubtitleRows, listArtifacts, providerMissActive, readBody, recordProviderMiss, recoverStaleSubtitleIndexJobs, storeSubtitleAsset, subtitleIndexStats, upsertSubtitleIndex } from '../src/lib/subtitles/storage';

// DECISION: crawl the small title catalog first and process one durable job at a time; provider concurrency caps are enforced per host.
const watch = process.argv.includes('--watch');
const seed = process.argv.includes('--seed');
let stopRequested = false;
let processedJobs = 0;
const lastProviderErrorLog = new Map<string, number>();
process.on('SIGINT', () => { stopRequested = true; console.log('Index worker will stop after the current job.'); });
process.on('SIGTERM', () => { stopRequested = true; console.log('Index worker will stop after the current job.'); });
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const normalize = (value: string) => value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

function makeRequest(titleId: number, episode: number, job?: Record<string, unknown>): SubtitleAnimeIds | undefined {
  const title = getTitleById(titleId);
  if (!title) return undefined;
  return {
    animeId: String(title.id), title: title.romaji || title.english || title.native || String(title.id),
    aliases: [title.english, title.native, title.title_bg].filter((value): value is string => Boolean(value)),
    episode, durationMs: Number(job?.duration_ms ?? getEpisodes(titleId).find(item => item.number === episode)?.duration ?? 0) || null,
    season: Number(job?.season_number) || null, fileHash: job?.video_hash ? String(job.video_hash) : null,
    releaseGroup: job?.release_group ? String(job.release_group) : null,
  };
}

async function seedCatalog(): Promise<void> {
  const entries = await crawlAnimeBgCatalog(true);
  const provider = new AniMaBgCatalogProvider();
  const titleRows = getTitles();
  for (const entry of entries) {
    const local = titleRows.find(title => [entry.title, ...entry.aliases].some(alias => [title.romaji, title.english, title.native, title.title_bg].some(name => name && normalize(name) === normalize(alias))));
    const animeId = local ? String(local.id) : `catalog:anima:${entry.providerId}`;
    const request: SubtitleAnimeIds = { animeId, title: entry.title, aliases: entry.aliases, episode: 0 };
    registerAnimeAliases(animeId, [entry.title, ...entry.aliases]);
    const candidate = (await provider.search(request, null, 0)).find(row => row.providerId === entry.providerId);
    if (candidate) upsertSubtitleIndex(candidate);
  }
  console.log(JSON.stringify({ seededCatalogTitles: entries.length, index: subtitleIndexStats() }));
}

async function seedValidatedArtifacts(): Promise<void> {
  const artifacts = listArtifacts();
  let indexed = 0;
  for (const artifact of artifacts) {
    if (artifact.target_language !== 'bg' || artifact.validation_status !== 'validated') continue;
    const animeId = Number(artifact.anime_id); const episode = Number(artifact.episode_id);
    if (!Number.isSafeInteger(animeId) || !Number.isSafeInteger(episode)) continue;
    const title = getTitleById(animeId);
    if (!title) continue;
    const raw = await readBody(String(artifact.translated_path));
    const stored = await storeSubtitleAsset(raw, String(artifact.translated_format), 'bg', { provider: 'local-validated-translation', model: artifact.model, sourceHash: artifact.source_hash, attribution: `Machine translated (${String(artifact.model)})` });
    upsertSubtitleIndex({ animeId: String(animeId), episodeNumber: episode, language: 'bg', provider: 'local-validated-translation', providerId: `${animeId}:${episode}:${artifact.source_hash}`, format: String(artifact.translated_format), qualityScore: 1, verified: true, fetchable: true, assetHash: stored.hash, attribution: `Machine translated (${String(artifact.model)})` });
    registerAnimeAliases(String(animeId), [title.romaji ?? '', title.english ?? '', title.native ?? '', title.title_bg ?? '']);
    indexed++;
  }
  console.log(JSON.stringify({ indexedValidatedBulgarian: indexed }));
}

function enqueueAllEpisodes(): number {
  let queued = 0;
  for (const title of getTitles()) for (const episode of getEpisodes(title.id)) if (enqueueSubtitleIndexJob({ animeId: String(title.id), episode: episode.number, durationMs: episode.duration == null ? null : episode.duration * 1000 })) queued++;
  return queued;
}

async function processJob(job: Record<string, unknown>): Promise<void> {
  const animeId = String(job.anime_id); const episode = Number(job.episode_number);
  const request = makeRequest(Number(animeId), episode, job);
  if (!request) { finishSubtitleIndexJob(Number(job.id), 'Anime is absent from the local catalogue'); return; }
  registerAnimeAliases(request.animeId, [request.title, ...(request.aliases ?? [])]);
  if (indexedSubtitleRows(request.animeId, episode).some(row => Number(row.quality_score) >= 0.85)) {
    finishSubtitleIndexJob(Number(job.id));
    return;
  }
  const providers = subtitleIndexProviders;
  let found = 0; let hadError = false;
  for (const provider of providers) {
    const existingRows = indexedSubtitleRows(request.animeId, episode);
    if (existingRows.some(row => Number(row.quality_score) >= 0.85)) break;
    if (existingRows.some(row => row.provider === provider.id)) continue;
    if (provider.id !== 'anima-bg-fansubs' && provider.id !== 'anime-subtitle-archival' && providerMissActive(request.animeId, episode, provider.id)) continue;
    try {
      const candidates = await provider.search(request, request.season ?? null, episode);
      if (!candidates.length) { recordProviderMiss(request.animeId, episode, provider.id); continue; }
      for (const candidate of candidates) {
        await indexSubtitleCandidate(provider, request, candidate);
        found++;
      }
    } catch (error) {
      hadError = true;
      recordProviderMiss(request.animeId, episode, provider.id);
      const lastLogged = lastProviderErrorLog.get(provider.id) ?? 0;
      if (Date.now() - lastLogged > 5 * 60_000) {
        console.error(JSON.stringify({ provider: provider.id, animeId, episode, error: error instanceof Error ? error.message : String(error) }));
        lastProviderErrorLog.set(provider.id, Date.now());
      }
    }
  }
  finishSubtitleIndexJob(Number(job.id), hadError ? `Provider indexing incomplete${found ? `; indexed ${found} candidate(s)` : ''}` : undefined);
}

async function run(): Promise<void> {
  if (seed) { await seedCatalog(); await seedValidatedArtifacts(); }
  const recovered = recoverStaleSubtitleIndexJobs();
  const queued = enqueueAllEpisodes();
  console.log(JSON.stringify({ queued, recovered, index: subtitleIndexStats() }));
  do {
    const jobs = claimSubtitleIndexJobs(1);
    for (const job of jobs) await processJob(job);
    processedJobs += jobs.length;
    if (!watch || stopRequested) break;
    if (!jobs.length) await sleep(5000);
    else if (processedJobs % 25 === 0) console.log(JSON.stringify({ processedJobs, index: subtitleIndexStats() }));
  } while (true);
}

void run().catch(error => { console.error(error); process.exitCode = 1; });
