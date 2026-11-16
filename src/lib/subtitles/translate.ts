import { createHash } from 'node:crypto';
import { subtitleConfig } from './config';
import { parseSubtitle, serializeSubtitle, type NormalizedSubtitle } from './normalize';
import { validateTranslation } from './qa';
import { findCachedArtifact, getGlossary, logJob, readBody, saveBody, storeValidatedArtifact, updateJob, workerControl, type Job } from './storage';
import { ProviderError, translateThroughProviders } from './providers';
import { formatTime } from './normalize';

export class SubtitleWorkerStop extends Error { constructor() { super('Worker requested a graceful stop after a saved batch'); this.name = 'SubtitleWorkerStop'; } }
export class SubtitleWorkerPause extends Error { constructor() { super('Worker paused after a saved batch'); this.name = 'SubtitleWorkerPause'; } }

export async function translateSubtitleJob(input: { job: Job; sourcePath: string; sourceLanguage: 'en' | 'ja'; sourceFormat: string; sourceHash: string; sourceBody: string; providerId: string }): Promise<{ artifactId: number; model: string; score: number; elapsedMs: number }> {
  const { job, sourcePath, sourceLanguage, sourceFormat, sourceHash, sourceBody, providerId } = input;
  updateJob(job.id, 'NORMALIZING', { sourceLanguage, providerId, sourceHash, checkpoint: { ...job.checkpoint, sourcePath, sourceFormat, sourceLanguage, sourceHash } });
  const subtitle = parseSubtitle(sourceBody, sourceFormat as 'srt' | 'ass' | 'ssa' | 'vtt');
  if (subtitle.sourceHash !== sourceHash) throw new Error('Downloaded subtitle content hash changed during normalization');
  const glossary = getGlossary(job.anime_id);
  const adapterVersion = 'subtitle-provider-adapters-v1';
  const providerSrt = `${subtitle.cues.map((cue, index) => `${index + 1}\n${formatTime(cue.start, true)} --> ${formatTime(cue.end, true)}\n${cue.originalText}`).join('\n\n')}\n`;
  const providerFailures: string[] = [];
  const providerStarted = Date.now();
  const acceptedProviderResult: { value: { artifactId: number; providerId: string; score: number } | null } = { value: null };
  const signal = new AbortController();
  const controlPoll = setInterval(() => {
    if (workerControl() === 'stopping' || workerControl() === 'paused') signal.abort(new Error('worker control changed'));
  }, 500);
  controlPoll.unref();
  updateJob(job.id, 'TRANSLATING', { sourceLanguage, providerId, sourceHash, error: null, checkpoint: { ...job.checkpoint, sourcePath, sourceFormat, sourceLanguage, sourceHash, providerChain: true, providerStartedAt: new Date().toISOString() } });
  logJob(job.id, 'info', 'subtitle_provider_chain_started', { providers: subtitleConfig.providerOrder, sourceLanguage, targetLanguage: 'bg' });
  try {
    const result = await translateThroughProviders({ srt: providerSrt, sourceLang: sourceLanguage, targetLang: 'bg' }, {
      signal: signal.signal,
      totalBudgetMs: subtitleConfig.providerJobBudgetMs,
      getCached: async id => {
        const cacheConfig = createHash('sha256').update(JSON.stringify({ sourceHash, targetLanguage: 'bg', providerId: id, adapterVersion })).digest('hex');
        const cachedProvider = findCachedArtifact(sourceHash, 'bg', cacheConfig, adapterVersion);
        return cachedProvider ? readBody(String(cachedProvider.translated_path)) : undefined;
      },
      onFailure: (id, reason) => {
        providerFailures.push(`${id}: ${reason}`);
        updateJob(job.id, 'TRANSLATING', { sourceLanguage, providerId: id, sourceHash, error: `${id}: ${reason}`.slice(0, 1000) });
        logJob(job.id, 'warn', 'subtitle_provider_failed', { provider: id, reason });
      },
      onSuccess: async (id, outputSrt, latencyMs, cacheHit) => {
        const output = parseSubtitle(outputSrt, 'srt');
        if (output.cues.length !== subtitle.cues.length) throw new Error(`provider cue parity failed: input=${subtitle.cues.length}, output=${output.cues.length}`);
        const translatedSubtitle: NormalizedSubtitle = {
          ...subtitle,
          cues: subtitle.cues.map((cue, index) => {
            const translatedCue = output.cues[index]!;
            if (cue.start !== translatedCue.start || cue.end !== translatedCue.end) throw new Error(`provider timestamp mismatch at cue ${index + 1}`);
            return { ...cue, translatedText: translatedCue.originalText };
          }),
        };
        const qa = validateTranslation(subtitle, { ...translatedSubtitle, cues: translatedSubtitle.cues.map(cue => ({ ...cue, originalText: cue.translatedText })) }, glossary);
        if (!qa.valid || qa.score < 0.65) throw new ProviderError(id, 'quality', `provider QA rejected output (score ${qa.score.toFixed(2)}): ${qa.issues.join(', ')}`);
        const outputBody = serializeSubtitle(translatedSubtitle, true);
        const savedSource = await saveBody(sourceBody, sourceFormat);
        const savedOutput = await saveBody(outputBody, subtitle.format);
        const cacheConfig = createHash('sha256').update(JSON.stringify({ sourceHash, targetLanguage: 'bg', providerId: id, adapterVersion })).digest('hex');
        const artifactId = storeValidatedArtifact({ animeId: job.anime_id, seasonId: job.season_id, episodeId: job.episode_id, sourceLanguage, targetLanguage: 'bg', sourceHash, model: `provider:${id}`, configHash: cacheConfig, translationVersion: adapterVersion, sourceFormat: subtitle.format, translatedFormat: subtitle.format, sourcePath: savedSource.path || sourcePath, translatedPath: savedOutput.path, score: qa.score });
        updateJob(job.id, 'VALIDATING', { sourceLanguage, providerId: id, sourceHash, error: null, checkpoint: { ...job.checkpoint, artifactId, providerId: id, cacheHit, totalCues: subtitle.cues.length, score: qa.score } });
        logJob(job.id, 'info', 'provider_translation_validated', { provider: id, cacheHit, latencyMs, score: qa.score, cues: subtitle.cues.length, qaWarnings: qa.issues });
        acceptedProviderResult.value = { artifactId, providerId: id, score: qa.score };
      },
    });
    const accepted = acceptedProviderResult.value;
    if (!accepted || accepted.providerId !== result.providerId) throw new Error('Provider chain returned without a validated artifact');
    return { artifactId: accepted.artifactId, model: `provider:${accepted.providerId}`, score: accepted.score, elapsedMs: result.cacheHit ? 0 : Date.now() - providerStarted };
  } catch (error) {
    if (workerControl() === 'stopping') throw new SubtitleWorkerStop();
    if (workerControl() === 'paused') throw new SubtitleWorkerPause();
    const reason = error instanceof Error ? error.message : String(error);
    logJob(job.id, 'warn', 'subtitle_provider_chain_exhausted', { reason, failures: providerFailures });
    updateJob(job.id, 'NORMALIZING', { sourceLanguage, providerId, sourceHash, error: reason.slice(0, 1000) });
    const failures = providerFailures.length ? providerFailures.join(' | ') : reason;
    throw new Error(`Online subtitle provider chain exhausted: ${failures}`.slice(0, 4000));
  } finally {
    clearInterval(controlPoll);
  }
}
