import { createHash } from 'node:crypto';
import { subtitleConfig } from './config';
import { activeModel, availableModels, modelCoverage, translateBatch, type SourceLanguage, type TranslationCue } from './inference';
import { parseSubtitle, serializeSubtitle, type Cue, type NormalizedSubtitle } from './normalize';
import { validateTranslation } from './qa';
import { prepareCueForTranslation, restoreCueFormatting } from './formatting';
import { findCachedArtifact, getGlossary, logJob, persistModelStatus, readBody, saveBody, storeValidatedArtifact, updateJob, workerControl, type Job } from './storage';
import { translateThroughProviders } from './providers';
import { formatTime } from './normalize';

export class SubtitleWorkerStop extends Error { constructor() { super('Worker requested a graceful stop after a saved batch'); this.name = 'SubtitleWorkerStop'; } }
export class SubtitleWorkerPause extends Error { constructor() { super('Worker paused after a saved batch'); this.name = 'SubtitleWorkerPause'; } }

function sameTags(source: string, translated: string): boolean {
  const collect = (value: string) => [...value.matchAll(/\{[^}]*\}|<[^>]+>/g)].map(match => match[0]);
  return JSON.stringify(collect(source)) === JSON.stringify(collect(translated));
}
function chooseBatch(cues: Cue[], offset: number, maxCues = subtitleConfig.batchSize): Cue[] {
  const selected: Cue[] = [];
  let tokenEstimate = 0;
  for (let index = offset; index < cues.length && selected.length < maxCues; index++) {
    const cue = cues[index]!;
    const cost = Math.ceil(cue.originalText.length / 3.25) + 12;
    if (selected.length && tokenEstimate + cost > subtitleConfig.maxBatchTokens) break;
    if (!selected.length && cost > subtitleConfig.maxBatchTokens) throw new Error(`Cue ${cue.id} exceeds the configured batch token ceiling`);
    selected.push(cue); tokenEstimate += cost;
  }
  return selected;
}
function cueForModel(cue: Cue): TranslationCue { return { id: cue.id, text: cue.originalText, speaker: cue.speaker }; }
function applyResult(cues: Cue[], output: Array<{ id: string; text: string }>): void {
  const translations = new Map(output.map(item => [item.id, item.text]));
  for (const cue of cues) cue.translatedText = translations.get(cue.id) ?? '';
}
async function translateOneBatch(language: SourceLanguage, cues: Cue[], context: Cue[], glossary: Array<{ source: string; target: string; note?: string }>, job: Job): Promise<{ model: string; output: Array<{ id: string; text: string }>; cueCount: number }> {
  let size = cues.length;
  let failure: unknown;
  const modelNames = [undefined, ...subtitleConfig.fallbackModels];
  for (let attempt = 0; attempt <= subtitleConfig.retryCount; attempt++) {
    const batch = cues.slice(0, size);
    for (const model of modelNames) {
      try {
        const prepared = batch.map(cue => prepareCueForTranslation(cueForModel(cue)));
        const modelContext = context.map(cue => prepareCueForTranslation(cueForModel(cue)).cue);
        const result = await translateBatch(language, prepared.map(item => item.cue), modelContext, glossary, model);
        const byId = new Map(batch.map(cue => [cue.id, cue]));
        for (const item of result.translations) {
          const original = byId.get(item.id)!;
          const restored = restoreCueFormatting(original.originalText, item.text);
          if (!sameTags(original.originalText, restored)) throw new Error(`Formatting tags changed for cue ${item.id}`);
          item.text = restored;
          if (!/[\p{Script=Cyrillic}]/u.test(item.text) && /[\p{L}]/u.test(original.originalText)) throw new Error(`Output is not Bulgarian Cyrillic for cue ${item.id}`);
        }
        return { model: result.model, output: result.translations, cueCount: batch.length };
      } catch (error) {
        failure = error;
        logJob(job.id, 'warn', 'batch_attempt_failed', { offset: Number(job.checkpoint.offset ?? 0), model: model ?? activeModel(), batchSize: size, attempt, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    if (size > 1) size = Math.max(1, Math.floor(size / 2));
  }
  throw failure instanceof Error ? failure : new Error(String(failure ?? 'Translation batch failed'));
}

export async function translateSubtitleJob(input: { job: Job; sourcePath: string; sourceLanguage: SourceLanguage; sourceFormat: string; sourceHash: string; sourceBody: string; providerId: string }): Promise<{ artifactId: number; model: string; score: number; elapsedMs: number }> {
  const { job, sourcePath, sourceLanguage, sourceFormat, sourceHash, sourceBody, providerId } = input;
  updateJob(job.id, 'NORMALIZING', { sourceLanguage, providerId, sourceHash, checkpoint: { ...job.checkpoint, sourcePath, sourceFormat, sourceLanguage, sourceHash } });
  const subtitle = parseSubtitle(sourceBody, sourceFormat as 'srt' | 'ass' | 'ssa' | 'vtt');
  if (subtitle.sourceHash !== sourceHash) throw new Error('Downloaded subtitle content hash changed during normalization');
  const glossary = getGlossary(job.anime_id);
  const providerVersion = 'subtitle-provider-adapters-v1';
  const providerSrt = `${subtitle.cues.map((cue, index) => `${index + 1}\n${formatTime(cue.start, true)} --> ${formatTime(cue.end, true)}\n${cue.originalText}`).join('\n\n')}\n`;
  const providerFailures: string[] = [];
  const providerStarted = Date.now();
  const acceptedProviderResult: { value: { artifactId: number; providerId: string; score: number } | null } = { value: null };
  updateJob(job.id, 'TRANSLATING', { sourceLanguage, providerId, sourceHash, error: null, checkpoint: { ...job.checkpoint, sourcePath, sourceFormat, sourceLanguage, sourceHash, providerChain: true, providerStartedAt: new Date().toISOString() } });
  logJob(job.id, 'info', 'subtitle_provider_chain_started', { providers: subtitleConfig.providerOrder, sourceLanguage, targetLanguage: 'bg' });
  try {
    const result = await translateThroughProviders({ srt: providerSrt, sourceLang: sourceLanguage, targetLang: 'bg' }, {
      totalBudgetMs: 300_000,
      getCached: async id => {
        const cacheConfig = createHash('sha256').update(JSON.stringify({ sourceHash, targetLanguage: 'bg', providerId: id, adapterVersion: providerVersion })).digest('hex');
        const cachedProvider = findCachedArtifact(sourceHash, 'bg', cacheConfig, providerVersion);
        return cachedProvider ? readBody(String(cachedProvider.translated_path)) : undefined;
      },
      onFailure: (id, reason) => {
        providerFailures.push(`${id}: ${reason}`);
        const error = `${id}: ${reason}`.slice(0, 1000);
        updateJob(job.id, 'TRANSLATING', { sourceLanguage, providerId: id, sourceHash, error });
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
        if (!qa.valid || qa.score < 0.65) throw new Error(`provider QA rejected output (score ${qa.score.toFixed(2)}): ${qa.issues.join(', ')}`);
        const outputBody = serializeSubtitle(translatedSubtitle, true);
        const savedSource = await saveBody(sourceBody, sourceFormat);
        const savedOutput = await saveBody(outputBody, subtitle.format);
        const cacheConfig = createHash('sha256').update(JSON.stringify({ sourceHash, targetLanguage: 'bg', providerId: id, adapterVersion: providerVersion })).digest('hex');
        const artifactId = storeValidatedArtifact({ animeId: job.anime_id, seasonId: job.season_id, episodeId: job.episode_id, sourceLanguage, targetLanguage: 'bg', sourceHash, model: `provider:${id}`, configHash: cacheConfig, translationVersion: providerVersion, sourceFormat: subtitle.format, translatedFormat: subtitle.format, sourcePath: savedSource.path || sourcePath, translatedPath: savedOutput.path, score: qa.score });
        updateJob(job.id, 'VALIDATING', { sourceLanguage, providerId: id, sourceHash, error: null, checkpoint: { ...job.checkpoint, artifactId, providerId: id, cacheHit, totalCues: subtitle.cues.length, score: qa.score } });
        logJob(job.id, 'info', 'provider_translation_validated', { provider: id, cacheHit, latencyMs, score: qa.score, cues: subtitle.cues.length });
        acceptedProviderResult.value = { artifactId, providerId: id, score: qa.score };
      },
    });
    const accepted = acceptedProviderResult.value;
    if (!accepted || accepted.providerId !== result.providerId) throw new Error('Provider chain returned without a validated artifact');
    return { artifactId: accepted.artifactId, model: `provider:${accepted.providerId}`, score: accepted.score, elapsedMs: result.cacheHit ? 0 : Date.now() - providerStarted };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logJob(job.id, 'warn', 'subtitle_provider_chain_exhausted', { reason, failures: providerFailures });
    updateJob(job.id, 'NORMALIZING', { sourceLanguage, providerId, sourceHash, error: reason.slice(0, 1000) });
  }
  const coverage = await modelCoverage();
  persistModelStatus(coverage as unknown as Record<string, unknown>);
  const configVersion = process.env.SUBTITLE_TRANSLATION_VERSION ?? subtitleConfig.translationVersion;
  const configHash = createHash('sha256').update(JSON.stringify({ promptVersion: '3', model: coverage.activeModel, sourceLanguage, sourceFormat, targetLanguage: 'bg', version: configVersion, temperature: subtitleConfig.temperature, contextWindow: subtitleConfig.contextWindow, batchSize: subtitleConfig.batchSize, maxBatchTokens: subtitleConfig.maxBatchTokens, contextOverlap: subtitleConfig.contextOverlap, glossary })).digest('hex');
  const cached = findCachedArtifact(sourceHash, 'bg', configHash, configVersion);
  if (cached) {
    const cacheModel = String(cached.model);
    const translated = await readBody(String(cached.translated_path));
    const translatedBody = await saveBody(translated, String(cached.translated_format));
    const artifactId = storeValidatedArtifact({ animeId: job.anime_id, seasonId: job.season_id, episodeId: job.episode_id, sourceLanguage, targetLanguage: 'bg', sourceHash, model: cacheModel, configHash, sourceFormat, translatedFormat: String(cached.translated_format), sourcePath, translatedPath: translatedBody.path, score: Number(cached.score) });
    return { artifactId, model: cacheModel, score: Number(cached.score), elapsedMs: 0 };
  }
  updateJob(job.id, 'NORMALIZING', { sourceLanguage, providerId, sourceHash, checkpoint: { ...job.checkpoint, sourcePath, sourceFormat, sourceLanguage, sourceHash, offset: Number(job.checkpoint.offset ?? 0), translated: job.checkpoint.translated ?? {} } });
  const checkpointMatches = job.checkpoint.translationVersion === configVersion && job.checkpoint.configHash === configHash;
  if (!checkpointMatches && Object.keys((job.checkpoint.translated ?? {}) as Record<string, string>).length) logJob(job.id, 'info', 'checkpoint_reset_for_translation_config', { previousVersion: job.checkpoint.translationVersion ?? null, currentVersion: configVersion, previousConfigHash: job.checkpoint.configHash ?? null, currentConfigHash: configHash });
  const checkpoint = checkpointMatches && job.checkpoint.translated && typeof job.checkpoint.translated === 'object' ? job.checkpoint.translated as Record<string, string> : {};
  for (const cue of subtitle.cues) cue.translatedText = checkpoint[cue.id] ?? '';
  const savedOffset = checkpointMatches ? Number(job.checkpoint.offset ?? 0) : 0;
  const firstMissing = subtitle.cues.findIndex(cue => !cue.translatedText);
  let offset = Math.min(savedOffset, firstMissing < 0 ? subtitle.cues.length : firstMissing);
  let adaptiveBatchSize = Math.max(1, Math.min(subtitleConfig.batchSize, checkpointMatches ? Number(job.checkpoint.adaptiveBatchSize ?? subtitleConfig.batchSize) : subtitleConfig.batchSize));
  let usedModel = coverage.activeModel;
  const processingStarted = Date.now() - (checkpointMatches ? Number(job.checkpoint.elapsedMs ?? 0) : 0);
  while (offset < subtitle.cues.length) {
    const batch = chooseBatch(subtitle.cues, offset, adaptiveBatchSize).filter(cue => !cue.translatedText);
    if (!batch.length) { offset++; continue; }
    updateJob(job.id, 'TRANSLATING', { checkpoint: { sourcePath, sourceFormat, sourceLanguage, sourceHash, translationVersion: configVersion, configHash, totalCues: subtitle.cues.length, offset, adaptiveBatchSize, elapsedMs: Date.now() - processingStarted, translated: Object.fromEntries(subtitle.cues.filter(cue => cue.translatedText).map(cue => [cue.id, cue.translatedText])) } });
    const contextStart = Math.max(0, offset - subtitleConfig.contextOverlap);
    const contextEnd = Math.min(subtitle.cues.length, offset + batch.length + subtitleConfig.contextOverlap);
    const context = [...subtitle.cues.slice(contextStart, offset), ...subtitle.cues.slice(offset + batch.length, contextEnd)].filter(cue => cue.originalText.trim());
    const result = await translateOneBatch(sourceLanguage, batch, context, glossary, { ...job, checkpoint: { ...job.checkpoint, offset } });
    usedModel = result.model;
    const acceptedBatch = batch.slice(0, result.cueCount);
    applyResult(acceptedBatch, result.output);
    if (result.cueCount < batch.length) adaptiveBatchSize = Math.max(1, Math.min(adaptiveBatchSize, result.cueCount));
    offset = subtitle.cues.indexOf(acceptedBatch[acceptedBatch.length - 1]!) + 1;
    const translated = Object.fromEntries(subtitle.cues.filter(cue => cue.translatedText).map(cue => [cue.id, cue.translatedText]));
    updateJob(job.id, 'TRANSLATING', { sourceLanguage, providerId, sourceHash, checkpoint: { sourcePath, sourceFormat, sourceLanguage, sourceHash, translationVersion: configVersion, configHash, totalCues: subtitle.cues.length, offset, adaptiveBatchSize, translated, model: usedModel, elapsedMs: Date.now() - processingStarted } });
    logJob(job.id, 'info', 'batch_checkpointed', { offset, total: subtitle.cues.length, model: usedModel, elapsedMs: Date.now() - processingStarted });
    if (workerControl() === 'stopping') throw new SubtitleWorkerStop();
    if (workerControl() === 'paused') throw new SubtitleWorkerPause();
  }
  updateJob(job.id, 'VALIDATING', { sourceLanguage, providerId, sourceHash, checkpoint: { sourcePath, sourceFormat, sourceLanguage, sourceHash, translationVersion: configVersion, configHash, totalCues: subtitle.cues.length, offset, adaptiveBatchSize, model: usedModel, translated: Object.fromEntries(subtitle.cues.map(cue => [cue.id, cue.translatedText])), elapsedMs: Date.now() - processingStarted } });
  const translated = { ...subtitle, cues: subtitle.cues.map(cue => ({ ...cue, translatedText: cue.translatedText })) };
  const qa = validateTranslation(subtitle, { ...subtitle, cues: translated.cues.map(cue => ({ ...cue, originalText: cue.translatedText })) }, glossary);
  if (!qa.valid || qa.score < 0.65) {
    logJob(job.id, 'error', 'validation_rejected', { score: qa.score, issues: qa.issues });
    throw new Error(`Subtitle QA rejected output (score ${qa.score.toFixed(2)}): ${qa.issues.join(', ')}`);
  }
  const sourceSaved = await saveBody(sourceBody, sourceFormat);
  const outputSaved = await saveBody(serializeSubtitle(translated, true), subtitle.format);
  const artifactId = storeValidatedArtifact({ animeId: job.anime_id, seasonId: job.season_id, episodeId: job.episode_id, sourceLanguage, targetLanguage: 'bg', sourceHash, model: usedModel, configHash, sourceFormat: subtitle.format, translatedFormat: subtitle.format, sourcePath: sourceSaved.path || sourcePath, translatedPath: outputSaved.path, score: qa.score });
  return { artifactId, model: usedModel, score: qa.score, elapsedMs: Date.now() - processingStarted };
}

export async function modelsStatus(): Promise<{ activeModel: string | null; models: Array<{ name: string; backend: string; size?: number; languages?: Record<SourceLanguage, boolean> }> }> {
  try { const result = await modelCoverage(); return result; }
  catch { return { activeModel: activeModel(), models: await availableModels().catch(() => []) }; }
}
