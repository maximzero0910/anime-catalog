import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { statfs } from 'node:fs/promises';
import { dirname } from 'node:path';
import { freemem, cpus, totalmem } from 'node:os';
import { getEpisodes, getTitles } from '../../../lib/db';
import { enqueueEligible } from '../../../lib/subtitles/queue';
import { addSubtitleTitleAlias, controlJob, deadLetters, getGlossary, jobStats, markSubtitleIndexRejected, markSubtitleIndexVerified, pendingSubtitleMappings, recentJobs, resolveSubtitleMapping, retryFailedJobs, setGlossary, setWorkerConcurrency, setWorkerControl, storedBulgarianCount, subtitleIndexProviderBreakdown, subtitleIndexReviewQueue, subtitleIndexStats, workerConcurrency, workerControl, workerProcessStatus } from '../../../lib/subtitles/storage';
import { subtitleConfig } from '../../../lib/subtitles/config';
import { adminAuthorized, adminTokenConfigured } from '../../../lib/admin-auth';
import { workerHeartbeats } from '../../../lib/worker-heartbeat';
import { readJsonBody, RequestBodyError } from '../../../lib/request-body';
import { resourceLimitSnapshot } from '../../../lib/resource-limits';
import { createCachedProbe } from '../../../lib/cached-probe';
import { catalogDatabasePath } from '../../../lib/catalog-path';

export const prerender = false;
const execFile = promisify(execFileCallback);

const gpuProbe = createCachedProbe(async () => {
  const { stdout } = await execFile('nvidia-smi', ['--query-gpu=name,memory.total,memory.used,utilization.gpu', '--format=csv,noheader,nounits'], { timeout: 1800 });
  const [name, total, used, utilization] = stdout.trim().split(',').map(value => value.trim());
  return name ? { name, vramTotalMiB: Number(total), vramUsedMiB: Number(used), utilizationPercent: Number(utilization) } : null;
}, { ttlMs: 60_000 });

async function resourceStats(): Promise<Record<string, unknown>> {
  const memoryTotal = totalmem(); const memoryFree = freemem();
  const gpu = await gpuProbe();
  let storage: { totalBytes: number; availableBytes: number; usedPercent: number } | null = null;
  try {
    const filesystem = await statfs(dirname(catalogDatabasePath()));
    const totalBytes = Number(filesystem.blocks) * Number(filesystem.bsize);
    const availableBytes = Number(filesystem.bavail) * Number(filesystem.bsize);
    if (Number.isFinite(totalBytes) && totalBytes > 0 && Number.isFinite(availableBytes) && availableBytes >= 0) {
      storage = { totalBytes, availableBytes, usedPercent: Math.round((totalBytes - availableBytes) / totalBytes * 100) };
    }
  } catch { /* Read-only or restricted filesystems may not expose statfs; omit the optional metric. */ }
  return { cpuCount: cpus().length, loadAverage: (await import('node:os')).loadavg(), memoryTotalBytes: memoryTotal, memoryFreeBytes: memoryFree, memoryUsedPercent: Math.round((memoryTotal - memoryFree) / memoryTotal * 100), storage, gpu };
}

function unauthorizedResponse(): Response {
  const configured = adminTokenConfigured(process.env.SUBTITLE_ADMIN_TOKEN);
  return Response.json(
    { error: configured ? 'unauthorized' : 'Set SUBTITLE_ADMIN_TOKEN to enable administration' },
    { status: configured ? 401 : 503, headers: { 'cache-control': 'no-store', ...(configured ? { 'WWW-Authenticate': 'Bearer realm="anineko-admin"' } : {}) } },
  );
}

export async function GET({ request }: { request: Request }): Promise<Response> {
  if (!adminAuthorized(request, process.env.SUBTITLE_ADMIN_TOKEN)) return unauthorizedResponse();
  const titles = getTitles();
  const eligible = titles.reduce((sum, title) => sum + getEpisodes(title.id).length, 0);
  const stats = jobStats();
  const requestedAnime = Number(new URL(request.url).searchParams.get('animeId'));
  const counts = (stats.counts ?? {}) as Record<string, number>;
  const payload = {
    eligibleEpisodes: eligible,
    alreadyBulgarian: storedBulgarianCount(),
    awaiting: (counts.QUEUED ?? 0) + (counts.DISCOVERED ?? 0),
    inFlight: (counts.DOWNLOADING ?? 0) + (counts.NORMALIZING ?? 0) + (counts.TRANSLATING ?? 0) + (counts.VALIDATING ?? 0),
    completed: counts.COMPLETED ?? 0,
    failed: counts.FAILED ?? 0,
    skipped: counts.SKIPPED ?? 0,
    meanTranslationSeconds: stats.meanSeconds,
    throughputPerHour: stats.throughputPerHour,
    activeTranslatedCues: stats.activeTranslatedCues,
    activeCuesPerHour: stats.activeCuesPerHour,
    activeEpisodeRemainingSeconds: stats.activeEpisodeRemainingSeconds,
    estimatedRemainingSeconds: typeof stats.meanSeconds === 'number' ? stats.meanSeconds * ((counts.QUEUED ?? 0) + (counts.DISCOVERED ?? 0) + (counts.DOWNLOADING ?? 0) + (counts.NORMALIZING ?? 0) + (counts.TRANSLATING ?? 0) + (counts.VALIDATING ?? 0)) / workerConcurrency() : null,
    worker: workerProcessStatus(), workerControl: workerControl(), concurrency: workerConcurrency(), configuredConcurrency: subtitleConfig.maxConcurrentJobs,
    backgroundWorkers: workerHeartbeats(),
    deadLetters: deadLetters(20), jobs: recentJobs(40), resources: await resourceStats(), resourceLimits: resourceLimitSnapshot(),
    subtitleIndex: subtitleIndexStats(),
    subtitleIndexProviders: subtitleIndexProviderBreakdown(),
    subtitleIndexReview: subtitleIndexReviewQueue(100),
    needsMapping: pendingSubtitleMappings(100),
    adminControlsEnabled: adminTokenConfigured(process.env.SUBTITLE_ADMIN_TOKEN),
    titles: titles.map(title => ({ id: title.id, name: title.english ?? title.romaji ?? `AniList ${title.id}` })),
    glossary: Number.isSafeInteger(requestedAnime) && requestedAnime > 0 ? getGlossary(requestedAnime) : [],
  };
  return Response.json(payload, { headers: { 'cache-control': 'no-store' } });
}

export async function POST({ request }: { request: Request }): Promise<Response> {
  if (!adminAuthorized(request, process.env.SUBTITLE_ADMIN_TOKEN)) return unauthorizedResponse();
  let body: Record<string, unknown>;
  try { body = await readJsonBody<Record<string, unknown>>(request, 256 * 1024); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : 'invalid-json' }, { status: error instanceof RequestBodyError ? error.status : 400 }); }
  const action = body.action;
  if (action === 'pause') setWorkerControl('paused');
  else if (action === 'resume') setWorkerControl('running');
  else if (action === 'stop') setWorkerControl('stopping');
  else if (action === 'retry-failed') return Response.json({ retried: retryFailedJobs() });
  else if (action === 'enqueue') {
    const animeIds = Array.isArray(body.animeIds) ? body.animeIds.map(Number).filter(id => Number.isSafeInteger(id) && id > 0) : undefined;
    const cap = Number(body.cap ?? subtitleConfig.queueCap);
    if (!Number.isSafeInteger(cap) || cap < 1 || cap > 10000) return Response.json({ error: 'invalid-cap' }, { status: 400 });
    return Response.json(enqueueEligible({ animeIds, cap }));
  } else if (action === 'concurrency') {
    const value = Number(body.value);
    if (!Number.isInteger(value) || value < 1 || value > subtitleConfig.maxConcurrentJobs) return Response.json({ error: `concurrency must be between 1 and SUBTITLE_MAX_CONCURRENT (${subtitleConfig.maxConcurrentJobs})` }, { status: 400 });
    setWorkerConcurrency(value);
  } else if (action === 'glossary') {
    const animeId = Number(body.animeId);
    const entries = Array.isArray(body.entries) ? body.entries as Array<Record<string, unknown>> : [];
    if (!Number.isSafeInteger(animeId) || animeId <= 0 || !entries.length || entries.length > 100) return Response.json({ error: 'glossary requires an animeId and 1–100 entries' }, { status: 400 });
    const normalized = entries.map(entry => ({ source: String(entry.source ?? '').trim(), target: String(entry.target ?? '').trim(), note: String(entry.note ?? '').trim() }));
    if (normalized.some(entry => !entry.source || !entry.target || entry.source.length > 200 || entry.target.length > 200 || entry.note.length > 500)) return Response.json({ error: 'glossary terms must be non-empty and within 200 characters' }, { status: 400 });
    setGlossary(animeId, normalized);
  } else if (action === 'retry' || action === 'skip') {
    const id = Number(body.id);
    if (!Number.isSafeInteger(id) || id <= 0) return Response.json({ error: 'invalid-job-id' }, { status: 400 });
    controlJob(id, action);
  } else if (action === 'verify-index' || action === 'reject-index') {
    const indexId = Number(body.indexId);
    if (!Number.isSafeInteger(indexId) || indexId <= 0) return Response.json({ error: 'invalid-index-id' }, { status: 400 });
    const evidence = String(body.evidence ?? body.reason ?? '').trim();
    if (evidence.length < 8 || evidence.length > 1000) return Response.json({ error: 'verification evidence must be 8–1000 characters' }, { status: 400 });
    try {
      if (action === 'verify-index') markSubtitleIndexVerified(indexId, evidence);
      else markSubtitleIndexRejected(indexId, evidence);
    } catch (error) { return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 409 }); }
  } else if (action === 'add-title-alias') {
    try { addSubtitleTitleAlias(String(body.anilistId ?? ''), String(body.sourceId ?? ''), String(body.sourceTitle ?? '')); }
    catch (error) { return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 }); }
  } else if (action === 'map-title-candidate' || action === 'reject-title-candidate') {
    const id = Number(body.id);
    if (!Number.isSafeInteger(id) || id <= 0) return Response.json({ error: 'invalid-mapping-id' }, { status: 400 });
    try { resolveSubtitleMapping(id, action === 'map-title-candidate' ? 'map' : 'reject'); }
    catch (error) { return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 409 }); }
  } else return Response.json({ error: 'unknown-action' }, { status: 400 });
  return Response.json({ ok: true, worker: workerControl(), concurrency: workerConcurrency() });
}
