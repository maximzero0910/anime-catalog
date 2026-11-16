import { freemem, totalmem } from 'node:os';
import { discoverTracks, downloadTrack, type SubtitleTrack } from '../src/lib/subtitles/acquire';
import { subtitleConfig } from '../src/lib/subtitles/config';
import { availableModels, modelCoverage } from '../src/lib/subtitles/inference';
import { parseSubtitle } from '../src/lib/subtitles/normalize';
import { addDeadLetter, claimJobs, claimUndiscoveredJobs, existingBulgarian, getJob, heartbeatJob, logJob, persistModelStatus, readBody, recordWorkerHeartbeat, recoverStaleJobs, saveBody, setWorkerControl, storeValidatedArtifact, updateJob, workerConcurrency, workerControl, type Job } from '../src/lib/subtitles/storage';
import { enqueueEligible } from '../src/lib/subtitles/queue';
import { SubtitleWorkerPause, SubtitleWorkerStop, translateSubtitleJob } from '../src/lib/subtitles/translate';

const args = process.argv.slice(2);
const option = (name: string) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const selectedAnime = option('--anime')?.split(',').map(Number).filter(Number.isSafeInteger);
const cap = Math.min(subtitleConfig.queueCap, Number(option('--cap') || subtitleConfig.queueCap));
const watch = args.includes('--watch');
let stopping = false;
recordWorkerHeartbeat();
const workerHeartbeat = setInterval(() => recordWorkerHeartbeat(), 10_000);
workerHeartbeat.unref();
const setStop = () => { stopping = true; setWorkerControl('stopping'); console.log('Graceful shutdown requested; current batch will checkpoint before exit.'); };
process.on('SIGINT', setStop);
process.on('SIGTERM', setStop);

function languageOf(track: { language: string }): 'en' | 'ja' { return track.language === 'ja' ? 'ja' : 'en'; }
async function saveNativeTrack(job: Job, track: SubtitleTrack, text: string): Promise<void> {
  const parsed = parseSubtitle(text, track.format);
  const source = await saveBody(text, parsed.format);
  storeValidatedArtifact({ animeId: job.anime_id, seasonId: job.season_id, episodeId: job.episode_id, sourceLanguage: 'bg', targetLanguage: 'bg', sourceHash: parsed.sourceHash, model: `provider:${track.provider}`, sourceFormat: parsed.format, translatedFormat: parsed.format, sourcePath: source.path, translatedPath: source.path, score: 1 });
  updateJob(job.id, 'COMPLETED', { sourceLanguage: 'bg', providerId: track.provider, sourceHash: parsed.sourceHash, checkpoint: { sourcePath: source.path, sourceFormat: parsed.format, sourceLanguage: 'bg' }, lockedAt: null });
  logJob(job.id, 'info', 'provider_bulgarian_saved', { cues: parsed.cues.length, provider: track.provider });
}
async function discoverQueuedJob(job: Job): Promise<void> {
  try {
    if (existingBulgarian(job.anime_id, Number(job.episode_id))) { updateJob(job.id, 'SKIPPED', { error: 'Validated Bulgarian subtitle already exists' }); return; }
    const tracks = await discoverTracks(job.anime_id, Number(job.episode_id));
    for (const bulgarian of tracks.filter(track => track.language === 'bg')) {
      try { const result = await downloadTrack(bulgarian); parseSubtitle(result.text, result.track.format); await saveNativeTrack(job, bulgarian, result.text); return; }
      catch (error) { logJob(job.id, 'warn', 'bulgarian_track_unusable', { provider: bulgarian.provider, reason: error instanceof Error ? error.message : String(error) }); }
    }
    const sources = [...tracks.filter(track => track.language === 'en'), ...tracks.filter(track => track.language === 'ja')];
    const source = sources[0];
    if (!source) throw new Error('No usable Bulgarian, English, or Japanese subtitle track was exposed by available providers');
    updateJob(job.id, 'QUEUED', { sourceLanguage: languageOf(source), providerId: source.provider, checkpoint: { ...job.checkpoint, sourceTrack: source, sourceTracks: sources }, lockedAt: null });
    logJob(job.id, 'info', 'tracks_discovered', { provider: source.provider, sourceLanguage: source.language, availableLanguages: [...new Set(tracks.map(track => track.language))], candidateCount: sources.length });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const latest = getJob(job.id)!; const terminal = latest.attempts >= subtitleConfig.retryCount + 3;
    const backoff = Math.min(60 * 60_000, subtitleConfig.retryDelayMs * (2 ** Math.max(0, latest.attempts - 1)) * Math.random());
    updateJob(job.id, 'FAILED', { error: reason, availableAt: terminal ? Number.MAX_SAFE_INTEGER : Date.now() + backoff, lockedAt: null });
    logJob(job.id, 'error', terminal ? 'discovery_dead_lettered' : 'discovery_failed', { reason, retryInMs: terminal ? 0 : backoff });
    if (terminal) addDeadLetter(latest, reason);
  }
}
async function runJob(job: Job): Promise<void> {
  const current = getJob(job.id)!;
  const heartbeat = setInterval(() => heartbeatJob(job.id), 15000);
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
      if (!tracks.length) tracks = await discoverTracks(job.anime_id, Number(job.episode_id));
      let nativeSaved = false;
      for (const bulgarian of tracks.filter(track => track.language === 'bg')) {
        try { const result = await downloadTrack(bulgarian); parseSubtitle(result.text, result.track.format); await saveNativeTrack(job, bulgarian, result.text); nativeSaved = true; break; }
        catch (error) { logJob(job.id, 'warn', 'bulgarian_track_unusable', { provider: bulgarian.provider, reason: error instanceof Error ? error.message : String(error) }); }
      }
      if (nativeSaved) return;
      let selected: SubtitleTrack | undefined;
      let downloaded: Awaited<ReturnType<typeof downloadTrack>> | undefined;
      let parsed: ReturnType<typeof parseSubtitle> | undefined;
      for (const language of ['en', 'ja'] as const) {
        for (const candidate of tracks.filter(track => track.language === language)) {
          try {
            const result = await downloadTrack(candidate);
            const normalized = parseSubtitle(result.text, result.track.format);
            selected = candidate; downloaded = result; parsed = normalized; break;
          } catch (error) { logJob(job.id, 'warn', 'source_track_unusable', { provider: candidate.provider, language, url: candidate.url, reason: error instanceof Error ? error.message : String(error) }); }
        }
        if (selected) break;
      }
      if (!selected || !downloaded || !parsed) throw new Error('No usable English subtitle track and no usable Japanese fallback were available');
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
    const terminal = latest.attempts >= maximumAttempts;
    const backoff = Math.min(60 * 60_000, subtitleConfig.retryDelayMs * (2 ** Math.max(0, latest.attempts - 1)) * Math.random());
    updateJob(job.id, 'FAILED', { error: message, availableAt: terminal ? Number.MAX_SAFE_INTEGER : Date.now() + backoff, lockedAt: null });
    logJob(job.id, 'error', terminal ? 'dead_lettered' : 'attempt_failed', { attempts: latest.attempts, retryInMs: terminal ? 0 : backoff, reason: message });
    if (terminal) addDeadLetter(latest, message);
    console.error(`FAILED job=${job.id} anime=${job.anime_id} ep=${job.episode_id}: ${message}${terminal ? ' (dead-letter)' : ''}`);
  } finally { clearInterval(heartbeat); }
}

async function main(): Promise<void> {
  if (args.includes('--enqueue') || args.length === 0) console.log(`Queue result: ${JSON.stringify(enqueueEligible({ animeIds: selectedAnime, cap }))}`);
  if (args.includes('--models')) { const coverage = await modelCoverage(true); persistModelStatus(coverage as unknown as Record<string, unknown>); console.log(JSON.stringify(coverage, null, 2)); return; }
  if (args.includes('--enqueue-only')) return;
  const recovered = recoverStaleJobs(subtitleConfig.staleLockMs);
  if (recovered) console.log(`Recovered ${recovered} stale jobs.`);
  const availableRam = freemem() / totalmem();
  if (availableRam < 1 - subtitleConfig.ramCeiling) throw new Error(`RAM headroom ${Math.round(availableRam * 100)}% is below the configured safety margin`);
  if (workerControl() === 'paused') console.log('Worker is paused; resume it from /admin/subtitles or the admin API.');
  const models = await availableModels();
  const selectedModel = subtitleConfig.model || [...models].sort((a, b) => (b.size ?? 0) - (a.size ?? 0))[0]?.name || null;
  persistModelStatus({ activeModel: selectedModel, models });
  console.log(`Worker active: maxConcurrency=${workerConcurrency()}, batchSize=${subtitleConfig.batchSize}, context=${subtitleConfig.contextWindow}, queueCap=${cap}`);
  while (!stopping && workerControl() !== 'stopping') {
    const newlyRecovered = recoverStaleJobs(subtitleConfig.staleLockMs);
    if (newlyRecovered) console.warn(`Recovered ${newlyRecovered} stale subtitle job(s).`);
    if (workerControl() === 'paused') { await new Promise(resolve => setTimeout(resolve, 2000)); continue; }
    if (freemem() / totalmem() < 1 - subtitleConfig.ramCeiling) {
      console.warn('RAM safety ceiling reached; pausing new jobs until headroom returns.');
      if (!watch) break;
      await new Promise(resolve => setTimeout(resolve, 10000));
      continue;
    }
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
  setWorkerControl('running');
  console.log('Worker stopped cleanly.');
}

main().catch(error => { console.error(error instanceof Error ? error.stack : error); process.exitCode = 1; }).finally(() => { clearInterval(workerHeartbeat); recordWorkerHeartbeat(0); process.exit(); });
