import { getEpisodes, getTitleById, getTitles } from '../src/lib/db';
import { subtitleMatchScore, indexSubtitleCandidate, registerAnimeAliases } from '../src/lib/subtitles/index';
import { AniMaBgCatalogProvider, crawlAnimeBgCatalog, subtitleIndexProviders, type SubtitleAnimeIds } from '../src/lib/subtitles/index-providers';
import { claimSubtitleIndexJobs, enqueueSubtitleIndexJob, finishSubtitleIndexJob, heartbeatSubtitleIndexJob, indexedSubtitleRows, listArtifacts, providerMissActive, pruneSubtitleOperationalData, readBody, recordProviderMiss, recoverStaleSubtitleIndexJobs, storeSubtitleAsset, subtitleIndexStats, syncSubtitleProviderEnabled, upsertSubtitleIndex } from '../src/lib/subtitles/storage';
import { startWorkerHeartbeat } from '../src/lib/worker-heartbeat';
import { indexProviderCandidates } from '../src/lib/subtitles/index-runner';
import { subtitleConfig } from '../src/lib/subtitles/config';
import { subtitleIndexerMode } from '../src/lib/subtitles/indexer-mode';

// DECISION: explicit catalog runs enqueue all episodes; the persistent service uses --queued-only to avoid startup fan-out.
const watch = process.argv.includes('--watch');
const seed = process.argv.includes('--seed');
const indexerMode = subtitleIndexerMode(process.argv.slice(2));
let stopRequested = false;
let processedJobs = 0;
const lastProviderErrorLog = new Map<string, number>();
const stopApplicationHeartbeat = startWorkerHeartbeat('subtitle-indexer');
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
  const jobId = Number(job.id);
  let lastHeartbeatErrorLog = 0;
  const heartbeat = setInterval(() => {
    try { heartbeatSubtitleIndexJob(jobId); }
    catch (error) {
      if (Date.now() - lastHeartbeatErrorLog >= 5 * 60_000) {
        console.warn(JSON.stringify({ event: 'subtitle_index_lease_refresh_failed', jobId, animeId, episode, reason: error instanceof Error ? error.message : String(error) }));
        lastHeartbeatErrorLog = Date.now();
      }
    }
  }, 15000);
  heartbeat.unref();
  try {
  const request = makeRequest(Number(animeId), episode, job);
  if (!request) { finishSubtitleIndexJob(jobId, 'Anime is absent from the local catalogue'); return; }
  registerAnimeAliases(request.animeId, [request.title, ...(request.aliases ?? [])]);
  if (indexedSubtitleRows(request.animeId, episode).some(row => Number(row.quality_score) >= 0.85)) {
    finishSubtitleIndexJob(jobId);
    return;
  }
  const providers = subtitleIndexProviders;
  let found = 0; let hadError = false;
  for (const provider of providers) {
    // Unconfigured providers are unavailable, not evidence that this episode lacks subtitles.
    if (!provider.isEnabled()) continue;
    const existingRows = indexedSubtitleRows(request.animeId, episode);
    if (existingRows.some(row => Number(row.quality_score) >= 0.85)) break;
    if (provider.id !== 'anima-bg-fansubs' && provider.id !== 'anime-subtitle-archival' && providerMissActive(request.animeId, episode, provider.id)) continue;
    try {
      const indexedProviderIds = new Set(existingRows.filter(row => row.provider === provider.id).map(row => String(row.provider_id)));
      found += await indexProviderCandidates({
        search: () => provider.search(request, request.season ?? null, episode),
        recordDefinitiveMiss: () => recordProviderMiss(request.animeId, episode, provider.id),
        isAlreadyIndexed: candidate => indexedProviderIds.has(candidate.providerId),
        index: async candidate => {
          await indexSubtitleCandidate(provider, request, candidate);
          indexedProviderIds.add(candidate.providerId);
        },
      });
    } catch (error) {
      hadError = true;
      const lastLogged = lastProviderErrorLog.get(provider.id) ?? 0;
      if (Date.now() - lastLogged > 5 * 60_000) {
        console.error(JSON.stringify({ provider: provider.id, animeId, episode, error: error instanceof Error ? error.message : String(error) }));
        lastProviderErrorLog.set(provider.id, Date.now());
      }
    }
  }
  finishSubtitleIndexJob(jobId, hadError ? `Provider indexing incomplete${found ? `; indexed ${found} candidate(s)` : ''}` : undefined);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    finishSubtitleIndexJob(jobId, reason);
    console.error(JSON.stringify({ event: 'subtitle_index_job_failed', animeId, episode, reason }));
  } finally {
    clearInterval(heartbeat);
  }
}

async function run(): Promise<void> {
  const pruned = pruneSubtitleOperationalData();
  if (Object.values(pruned).some(count => count > 0)) console.info({ event: 'subtitle_operational_data_pruned', ...pruned });
  for (const provider of subtitleIndexProviders) {
    const requeued = syncSubtitleProviderEnabled(provider.id, provider.isEnabled());
    if (requeued) console.info({ event: 'subtitle_provider_enabled_recovery', provider: provider.id, requeued });
  }
  if (seed) { await seedCatalog(); await seedValidatedArtifacts(); }
  const recovered = recoverStaleSubtitleIndexJobs(subtitleConfig.indexStaleLockMs);
  const queued = indexerMode === 'catalog' ? enqueueAllEpisodes() : 0;
  console.log(JSON.stringify({ mode: indexerMode, queued, recovered, index: subtitleIndexStats() }));
  do {
    const jobs = claimSubtitleIndexJobs(1);
    for (const job of jobs) await processJob(job);
    processedJobs += jobs.length;
    if (!watch || stopRequested) break;
    if (!jobs.length) await sleep(5000);
    else if (processedJobs % 25 === 0) console.log(JSON.stringify({ processedJobs, index: subtitleIndexStats() }));
  } while (true);
}

void run().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => stopApplicationHeartbeat());
