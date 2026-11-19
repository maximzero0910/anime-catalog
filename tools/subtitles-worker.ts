import { discoverTracksDetailed, downloadTrack, firstUsableTrack, resolveSubtitleSourceDetailed, type SubtitleTrack } from '../src/lib/subtitles/acquire';
import { subtitleConfig } from '../src/lib/subtitles/config';
import { parseSubtitle } from '../src/lib/subtitles/normalize';
import { addDeadLetter, claimJobs, claimUndiscoveredJobs, compareAndSetWorkerControl, existingBulgarian, getJob, heartbeatJob, logJob, pruneSubtitleOperationalData, readBody, recordWorkerHeartbeat, recoverStaleJobs, requeueExpiredSubtitleSources, saveBody, saveSubtitleHardsub, setWorkerControl, skipJobForNoSubtitleSource, storeValidatedArtifact, subtitleQueueDepth, updateJob, workerConcurrency, workerControl, type Job, type WorkerControl } from '../src/lib/subtitles/storage';
import { enqueueEligible, shouldRefillSubtitleQueue } from '../src/lib/subtitles/queue';
import { subtitleDiscoveryNeedsRetry } from '../src/lib/subtitles/provider-fallback';
import { SubtitleWorkerPause, SubtitleWorkerStop, translateSubtitleJob } from '../src/lib/subtitles/translate';
import { nextProviderAvailableAt } from '../src/lib/subtitles/providers';
import { startWorkerHeartbeat } from '../src/lib/worker-heartbeat';

const args = process.argv.slice(2);
const option = (name: string) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const selectedAnime = option('--anime')?.split(',').map(Number).filter(Number.isSafeInteger);
const cap = Math.min(subtitleConfig.queueCap, Number(option('--cap') || subtitleConfig.queueCap));
const watch = args.includes('--watch');
const stopApplicationHeartbeat = startWorkerHeartbeat('subtitle-worker');
let stopping = false;
recordWorkerHeartbeat();
const workerHeartbeat = setInterval(() => recordWorkerHeartbeat(), 10_000);
workerHeartbeat.unref();
let controlAtShutdown: WorkerControl | undefined;
let lastQueueRefillAt = 0;
const setStop = () => {
  if (stopping) return;
  stopping = true;
  try {
    controlAtShutdown = workerControl();
    if (controlAtShutdown === 'running') setWorkerControl('stopping');
  } catch (error) {
    console.error({ event: 'subtitle_worker_shutdown_control_failed', reason: error instanceof Error ? error.name : 'unknown' });
  }
  console.log('Graceful shutdown requested; current batch will checkpoint before exit.');
};
process.on('SIGINT', setStop);
process.on('SIGTERM', setStop);

function languageOf(track: { language: string }): 'en' | 'ja' { return track.language === 'ja' ? 'ja' : 'en'; }
function refillKaggleQueue(force = false): void {
  if (subtitleConfig.translationMode !== 'kaggle') return;
  const now = Date.now();
  if (!force && now - lastQueueRefillAt < subtitleConfig.queueRefillIntervalMs) return;
  lastQueueRefillAt = now;
  const requeued = requeueExpiredSubtitleSources(cap);
  const depth = subtitleQueueDepth();
  if (!shouldRefillSubtitleQueue(depth, subtitleConfig.queueRefillThreshold)) {
    if (force) console.info({ event: 'kaggle_queue_refill_skipped', reason: 'backlog_above_low_watermark', queueDepth: depth, threshold: subtitleConfig.queueRefillThreshold, requeuedExpiredNoSource: requeued });
    return;
  }
  const result = enqueueEligible({ animeIds: selectedAnime, cap });
  console.info({ event: 'kaggle_queue_refilled', reason: force ? 'startup' : 'low_watermark', queueDepthBefore: depth, requeuedExpiredNoSource: requeued, threshold: subtitleConfig.queueRefillThreshold, ...result });
}
async function saveNativeTrack(job: Job, track: SubtitleTrack, text: string): Promise<void> {
  const parsed = parseSubtitle(text, track.format);
  const source = await saveBody(text, parsed.format);
  storeValidatedArtifact({ animeId: job.anime_id, seasonId: job.season_id, episodeId: job.episode_id, sourceLanguage: 'bg', targetLanguage: 'bg', sourceHash: parsed.sourceHash, model: `provider:${track.provider}`, sourceFormat: parsed.format, translatedFormat: parsed.format, sourcePath: source.path, translatedPath: source.path, score: 1 });
  updateJob(job.id, 'COMPLETED', { sourceLanguage: 'bg', providerId: track.provider, sourceHash: parsed.sourceHash, checkpoint: { sourcePath: source.path, sourceFormat: parsed.format, sourceLanguage: 'bg' }, lockedAt: null });
  logJob(job.id, 'info', 'provider_bulgarian_saved', { cues: parsed.cues.length, provider: track.provider });
}
async function discoverQueuedJob(job: Job): Promise<void> {
  let lastHeartbeatErrorLog = 0;
  const heartbeat = setInterval(() => {
    try { heartbeatJob(job.id); }
    catch (error) {
      if (Date.now() - lastHeartbeatErrorLog >= 5 * 60_000) {
        console.warn(JSON.stringify({ event: 'subtitle_job_lease_refresh_failed', jobId: job.id, reason: error instanceof Error ? error.message : String(error) }));
        lastHeartbeatErrorLog = Date.now();
      }
    }
  }, 15000);
  heartbeat.unref();
  try {
    if (existingBulgarian(job.anime_id, Number(job.episode_id))) { updateJob(job.id, 'SKIPPED', { error: 'Validated Bulgarian subtitle already exists' }); return; }
    const discovery = await resolveSubtitleSourceDetailed(job.anime_id, Number(job.episode_id));
    const candidates = discovery.candidates;
    logJob(job.id, 'info', 'subtitle_discovery_finished', {
      state: discovery.state, checkedProviders: discovery.checkedProviders, emptyProviders: discovery.emptyProviders,
      primaryProvider: discovery.primaryProvider, primaryEmpty: discovery.primaryEmpty,
      exhaustedAllProviders: discovery.exhaustedAllProviders, candidateCount: candidates.length, failureCount: discovery.errors.length,
    });
    for (const providerFailure of discovery.errors) logJob(job.id, 'warn', 'subtitle_provider_search_failed', providerFailure);
    const hardsub = candidates.find(candidate => candidate.kind === 'hardsub');
    const tracks: SubtitleTrack[] = candidates.filter(candidate => candidate.kind === 'file' && (candidate.url || candidate.fetch)).map(candidate => ({ language: candidate.language ?? 'bg', url: candidate.url, format: candidate.format ?? 'srt', provider: candidate.sourceId, headers: {}, attribution: candidate.attribution, fetch: candidate.fetch }));
    if (hardsub) {
      saveSubtitleHardsub({ animeId: job.anime_id, episode: Number(job.episode_id), sourceId: hardsub.sourceId, sourceTitle: hardsub.title, sourceUrl: hardsub.url });
      logJob(job.id, 'info', 'hardsub_detected_no_ocr', { source: hardsub.sourceId, title: hardsub.title });
    }
    let fileFailures = 0;
    for (const bulgarian of tracks.filter(track => track.language === 'bg')) {
      try { const result = await downloadTrack(bulgarian); parseSubtitle(result.text, result.track.format); await saveNativeTrack(job, bulgarian, result.text); return; }
      catch (error) { fileFailures++; logJob(job.id, 'warn', 'bulgarian_track_unusable', { provider: bulgarian.provider, reason: error instanceof Error ? error.message : String(error) }); }
    }
    const selection = await firstUsableTrack(tracks, ['en', 'ja']);
    for (const failure of selection.failures) { fileFailures++; logJob(job.id, 'warn', 'source_track_unusable', { ...failure }); }
    let source = selection.track;
    let storedSource: Awaited<ReturnType<typeof saveBody>> | undefined;
    let parsedSource = selection.parsed;
    const sourceText = selection.downloaded?.text ?? '';
    if (source && parsedSource && selection.downloaded) storedSource = await saveBody(selection.downloaded.text, parsedSource.format);
    if (!source || !storedSource || !parsedSource) {
      if (subtitleDiscoveryNeedsRetry(discovery, fileFailures)) {
        const failedProviders = discovery.errors.map(item => item.provider).join(',');
        throw new Error(`Subtitle discovery incomplete${failedProviders ? `; provider failures: ${failedProviders}` : ''}; ${fileFailures} candidate file(s) unusable`);
      }
      if (hardsub) {
        updateJob(job.id, 'SKIPPED', { providerId: hardsub.sourceId, error: `Bulgarian hardsub available at ${hardsub.sourceId}; OCR is disabled` });
        return;
      }
      skipJobForNoSubtitleSource(job.id);
      return;
    }
    updateJob(job.id, 'QUEUED', { sourceLanguage: languageOf(source), providerId: source.provider, sourceHash: parsedSource.sourceHash, checkpoint: { ...job.checkpoint, sourcePath: storedSource.path, sourceHash: parsedSource.sourceHash, sourceLanguage: languageOf(source), sourceFormat: parsedSource.format, providerId: source.provider }, lockedAt: null });
    logJob(job.id, 'info', 'tracks_discovered', { provider: source.provider, sourceLanguage: source.language, availableLanguages: [...new Set(tracks.map(track => track.language))], candidateCount: tracks.filter(track => track.language === 'en' || track.language === 'ja').length });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (/^no subtitle source$/i.test(reason)) {
      skipJobForNoSubtitleSource(job.id, reason);
      return;
    }
    const latest = getJob(job.id)!; const terminal = latest.attempts >= subtitleConfig.retryCount + 3;
    const backoff = Math.min(60 * 60_000, subtitleConfig.retryDelayMs * (2 ** Math.max(0, latest.attempts - 1)) * Math.random());
    updateJob(job.id, 'FAILED', { error: reason, availableAt: terminal ? Number.MAX_SAFE_INTEGER : Date.now() + backoff, lockedAt: null });
    logJob(job.id, 'error', terminal ? 'discovery_dead_lettered' : 'discovery_failed', { reason, retryInMs: terminal ? 0 : backoff });
    if (terminal) addDeadLetter(latest, reason);
  } finally { clearInterval(heartbeat); }
}
async function runJob(job: Job): Promise<void> {
  const current = getJob(job.id)!;
  let lastHeartbeatErrorLog = 0;
  const heartbeat = setInterval(() => {
    try { heartbeatJob(job.id); }
    catch (error) {
      if (Date.now() - lastHeartbeatErrorLog >= 5 * 60_000) {
        console.warn(JSON.stringify({ event: 'subtitle_job_lease_refresh_failed', jobId: job.id, reason: error instanceof Error ? error.message : String(error) }));
        lastHeartbeatErrorLog = Date.now();
      }
    }
  }, 15000);
  heartbeat.unref();
  try {
    if (existingBulgarian(job.anime_id, Number(job.episode_id))) {
      updateJob(job.id, 'SKIPPED', { error: 'Validated Bulgarian subtitle already exists' });
      logJob(job.id, 'info', 'skipped_existing_bulgarian');
      return;
    }
    let sourcePath = typeof current.checkpoint.sourcePath === 'string' ? current.checkpoint.sourcePath : '';
    let sourceLanguage = (current.checkpoint.sourceLanguage as string | undefined) ?? '';
    let sourceFormat = (current.checkpoint.sourceFormat as string | undefined) ?? '';
    let sourceHash = (current.checkpoint.sourceHash as string | undefined) ?? '';
    let providerId = current.provider_id ?? '';
    let sourceBody = '';
    if (sourcePath && sourceLanguage && sourceFormat && sourceHash) {
      sourceBody = await readBody(sourcePath);
    } else {
      let tracks = Array.isArray(current.checkpoint.sourceTracks) ? current.checkpoint.sourceTracks as SubtitleTrack[] : [];
      let discoveryErrors: Array<{ provider: string; reason: string }> = [];
      if (!tracks.length) {
        const discovered = await discoverTracksDetailed(job.anime_id, Number(job.episode_id));
        tracks = discovered.tracks;
        discoveryErrors = discovered.discovery.errors;
        for (const providerFailure of discoveryErrors) logJob(job.id, 'warn', 'subtitle_provider_search_failed', providerFailure);
      }
      let nativeSaved = false;
      for (const bulgarian of tracks.filter(track => track.language === 'bg')) {
        try { const result = await downloadTrack(bulgarian); parseSubtitle(result.text, result.track.format); await saveNativeTrack(job, bulgarian, result.text); nativeSaved = true; break; }
        catch (error) { logJob(job.id, 'warn', 'bulgarian_track_unusable', { provider: bulgarian.provider, reason: error instanceof Error ? error.message : String(error) }); }
      }
      if (nativeSaved) return;
      const selection = await firstUsableTrack(tracks, ['en', 'ja']);
      for (const failure of selection.failures) logJob(job.id, 'warn', 'source_track_unusable', { ...failure });
      const selected = selection.track;
      const downloaded = selection.downloaded;
      const parsed = selection.parsed;
      if (!selected || !downloaded || !parsed) {
        if (discoveryErrors.length) throw new Error(`Subtitle discovery incomplete; provider failures: ${discoveryErrors.map(item => item.provider).join(',')}`);
        throw new Error('No usable English subtitle track and no usable Japanese fallback were available');
      }
      sourceLanguage = languageOf(selected); providerId = selected.provider;
      updateJob(job.id, 'DOWNLOADING', { sourceLanguage, providerId, checkpoint: current.checkpoint, lockedAt: Date.now() });
      const stored = await saveBody(downloaded.text, parsed.format);
      sourceBody = downloaded.text; sourcePath = stored.path; sourceHash = parsed.sourceHash; sourceFormat = parsed.format;
      updateJob(job.id, 'NORMALIZING', { sourceLanguage, providerId, sourceHash, checkpoint: { ...current.checkpoint, sourcePath, sourceHash, sourceLanguage, sourceFormat, providerId, offset: 0, translated: {} } });
      logJob(job.id, 'info', 'source_downloaded', { provider: providerId, language: sourceLanguage, format: sourceFormat, hash: sourceHash, bytes: Buffer.byteLength(sourceBody) });
    }
    if (sourceLanguage === 'bg') throw new Error('A Bulgarian track must be stored as a provider artifact, not sent through translation');
    const result = await translateSubtitleJob({ job: { ...getJob(job.id)!, checkpoint: current.checkpoint }, sourcePath, sourceLanguage: sourceLanguage as 'en' | 'ja', sourceFormat, sourceHash, sourceBody, providerId });
    updateJob(job.id, 'COMPLETED', { sourceLanguage, providerId, sourceHash, error: null, checkpoint: { ...getJob(job.id)!.checkpoint, artifactId: result.artifactId, model: result.model, score: result.score }, lockedAt: null });
    logJob(job.id, 'info', 'translation_completed', { artifactId: result.artifactId, model: result.model, score: result.score, elapsedMs: result.elapsedMs });
    console.log(`COMPLETED job=${job.id} anime=${job.anime_id} ep=${job.episode_id} source=${sourceLanguage} model=${result.model} score=${result.score.toFixed(2)}`);
  } catch (error) {
    if (error instanceof SubtitleWorkerStop) {
      updateJob(job.id, 'QUEUED', { error: null, lockedAt: null });
      logJob(job.id, 'info', 'graceful_stop_checkpointed', { checkpoint: getJob(job.id)?.checkpoint });
      console.log(`QUEUED job=${job.id} after graceful stop; saved translation batches will resume.`);
      return;
    }
    if (error instanceof SubtitleWorkerPause) {
      updateJob(job.id, 'QUEUED', { error: null, lockedAt: null });
      logJob(job.id, 'info', 'pause_checkpointed', { checkpoint: getJob(job.id)?.checkpoint });
      console.log(`QUEUED job=${job.id} after pause; saved translation batches will resume when resumed.`);
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    const latest = getJob(job.id)!;
    const maximumAttempts = subtitleConfig.retryCount + 3;
    const providerReadyAt = nextProviderAvailableAt();
    const cooldownWait = message.includes('all providers are cooling down') && providerReadyAt !== null;
    const terminal = latest.attempts >= maximumAttempts && !cooldownWait;
    const backoff = Math.min(60 * 60_000, subtitleConfig.retryDelayMs * (2 ** Math.max(0, latest.attempts - 1)) * Math.random());
    const retryInMs = terminal ? 0 : Math.max(backoff, providerReadyAt === null ? 0 : providerReadyAt - Date.now());
    updateJob(job.id, 'FAILED', { error: message, availableAt: terminal ? Number.MAX_SAFE_INTEGER : Date.now() + retryInMs, lockedAt: null, ...(cooldownWait ? { attempts: Math.max(0, latest.attempts - 1) } : {}) });
    logJob(job.id, 'error', terminal ? 'dead_lettered' : 'attempt_failed', { attempts: latest.attempts, retryInMs, reason: message, providerCooldownWait: cooldownWait });
    if (terminal) addDeadLetter(latest, message);
    console.error(`FAILED job=${job.id} anime=${job.anime_id} ep=${job.episode_id}: ${message}${terminal ? ' (dead-letter)' : ''}`);
  } finally { clearInterval(heartbeat); }
}

async function main(): Promise<void> {
  const pruned = pruneSubtitleOperationalData();
  if (Object.values(pruned).some(count => count > 0)) console.info({ event: 'subtitle_operational_data_pruned', ...pruned });
  if (args.includes('--enqueue') || args.length === 0) console.log(`Queue result: ${JSON.stringify(enqueueEligible({ animeIds: selectedAnime, cap }))}`);
  if (args.includes('--enqueue-only')) return;
  const recovered = recoverStaleJobs(subtitleConfig.staleLockMs);
  if (recovered) console.log(`Recovered ${recovered} stale jobs.`);
  if (workerControl() === 'paused') console.log('Worker is paused; resume it from /admin/subtitles or the admin API.');
  console.log(`Online subtitle worker active: maxConcurrency=${workerConcurrency()}, providers=${subtitleConfig.providerOrder.join(',')}, queueCap=${cap}`);
  // In Kaggle mode this Pi process prepares sources and continuously keeps a bounded reservoir
  // of work available; translation itself remains exclusively on authenticated Kaggle workers.
  if (watch) refillKaggleQueue(true);
  while (!stopping) {
    const newlyRecovered = recoverStaleJobs(subtitleConfig.staleLockMs);
    if (newlyRecovered) console.warn(`Recovered ${newlyRecovered} stale subtitle job(s).`);
    const control = workerControl();
    if (control === 'paused' || control === 'stopping') { await new Promise(resolve => setTimeout(resolve, 2000)); continue; }
    refillKaggleQueue();
    const undiscovered = claimUndiscoveredJobs(workerConcurrency());
    if (undiscovered.length) { await Promise.all(undiscovered.map(discoverQueuedJob)); continue; }
    const jobs = claimJobs(workerConcurrency());
    if (!jobs.length) {
      if (!watch) break;
      await new Promise(resolve => setTimeout(resolve, 5000));
      continue;
    }
    await Promise.all(jobs.map(runJob));
  }
  console.log('Worker stopped cleanly.');
}

main().catch(error => { console.error(error instanceof Error ? error.stack : error); process.exitCode = 1; }).finally(() => {
  clearInterval(workerHeartbeat);
  if (controlAtShutdown === 'running') {
    try { compareAndSetWorkerControl('stopping', 'running'); }
    catch (error) { console.error({ event: 'subtitle_worker_shutdown_control_restore_failed', reason: error instanceof Error ? error.name : 'unknown' }); }
  }
  stopApplicationHeartbeat();
});
