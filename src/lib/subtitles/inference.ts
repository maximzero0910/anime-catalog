import { subtitleConfig } from './config';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

export type SourceLanguage = 'en' | 'ja';
export interface TranslationCue { id: string; text: string; speaker: string | null; }
export interface ModelInfo { name: string; backend: 'ollama' | 'openai-compatible'; size?: number; languages?: Record<SourceLanguage, boolean>; }
export interface TranslationResult { id: string; text: string; }
export class InferenceError extends Error { constructor(message: string, readonly model: string, readonly retryable = true) { super(message); this.name = 'InferenceError'; } }

let discovered: ModelInfo[] | undefined;
let selectedModel: string | undefined;
let discoveryPromise: Promise<ModelInfo[]> | undefined;
const probeCache = new Map<string, Partial<Record<SourceLanguage, boolean>>>();
const execFile = promisify(execFileCallback);
const gpuLayers = new Map<string, number | undefined>();

function endpoint(path: string): string { return `${subtitleConfig.ollamaUrl}${path}`; }
async function request(url: string, body?: unknown, timeoutMs = 12000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal }); }
  catch (error) { if (controller.signal.aborted) throw new Error(`Local inference request timed out after ${timeoutMs}ms`); throw error; }
  finally { clearTimeout(timer); }
}
async function json(response: Response): Promise<Record<string, unknown>> {
  const body = await response.text();
  if (!response.ok) throw new Error(`Inference HTTP ${response.status}: ${body.slice(0, 400)}`);
  try { return JSON.parse(body) as Record<string, unknown>; } catch { throw new Error(`Inference server returned malformed JSON: ${body.slice(0, 200)}`); }
}

export async function availableModels(refresh = false): Promise<ModelInfo[]> {
  if (discovered && !refresh) return discovered;
  if (discoveryPromise && !refresh) return discoveryPromise;
  discoveryPromise = (async () => {
    const result: ModelInfo[] = [];
    if (subtitleConfig.inferenceUrl) {
      try {
        const response = await request(`${subtitleConfig.inferenceUrl}/v1/models`);
        const payload = await json(response);
        const data = Array.isArray(payload.data) ? payload.data as Array<Record<string, unknown>> : [];
        for (const model of data) if (typeof model.id === 'string') result.push({ name: model.id, backend: 'openai-compatible' });
      } catch { /* Continue to Ollama discovery. */ }
    }
    try {
      const payload = await json(await request(endpoint('/api/tags')));
      const models = Array.isArray(payload.models) ? payload.models as Array<Record<string, unknown>> : [];
      for (const model of models) if (typeof model.name === 'string' && !result.some(found => found.name === model.name)) result.push({ name: model.name, backend: 'ollama', size: typeof model.size === 'number' ? model.size : undefined });
    } catch (error) {
      if (!result.length) throw new Error(`No local inference backend is available: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!result.length) throw new Error('No local inference models are installed');
    discovered = result;
    discoveryPromise = undefined;
    return result;
  })();
  return discoveryPromise;
}

function promptFor(language: SourceLanguage, cues: TranslationCue[], context: TranslationCue[], glossary: Array<{ source: string; target: string; note?: string }>): string {
  const sourceName = language === 'en' ? 'English' : 'Japanese';
  const termList = glossary.length ? glossary.map(item => `- ${item.source} → ${item.target}${item.note ? ` (${item.note})` : ''}`).join('\n') : '(No series glossary entries yet.)';
  return `You are a native Bulgarian subtitle writer adapting ${sourceName} anime dialogue for broadcast. Write fluent, idiomatic Bulgarian that sounds originally written in Bulgarian, never like a word-for-word translation. Preserve meaning, character voice, emotion, register, jokes, and anime terminology; keep subtitle lines concise. Prefer natural Bulgarian word order and active phrasing. Use correct Bulgarian gender, articles, verb forms, and clitic placement (for example, say "ще го убием", never "ще убием го"). Avoid Russianisms and other Slavic calques. For songs, use natural, vivid Bulgarian while preserving the imagery and tone. Do not translate character or place names unless the glossary says so. Formatting is represented by ⟦SUBTITLE_TAG_n⟧ markers; copy every marker exactly once and in the same position/order, as each maps to an original ASS or HTML formatting tag. Never change cue IDs or combine, omit, or split cues. Silently proofread each translation for natural Bulgarian before returning it. Return only a JSON object shaped exactly as {"translations":[{"id":"...","text":"..."}]}; include every input cue once, in input order.\n\nSeries terminology glossary; use these Bulgarian equivalents consistently:\n${termList}\n\nNeighbouring dialogue for context only; do not return it:\n${JSON.stringify(context.map(cue => ({ id: cue.id, text: cue.text })))}\n\nTranslate these cues:\n${JSON.stringify(cues.map(cue => ({ id: cue.id, speaker: cue.speaker, text: cue.text })))}`;
}

async function complete(model: ModelInfo, prompt: string, maxTokens: number): Promise<string> {
  const generationMs = Math.ceil(maxTokens / 5 * 1000 + 30000);
  const timeoutMs = Math.min(600000, Math.max(subtitleConfig.timeoutMs, generationMs));
  if (model.backend === 'openai-compatible' && subtitleConfig.inferenceUrl) {
    const result = await json(await request(`${subtitleConfig.inferenceUrl}/v1/chat/completions`, {
      model: model.name, temperature: subtitleConfig.temperature, max_tokens: maxTokens, response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: 'Translate subtitles. Output only the requested JSON object.' }, { role: 'user', content: prompt }],
    }, timeoutMs));
    const choices = result.choices as Array<{ message?: { content?: string } }> | undefined;
    const text = choices?.[0]?.message?.content;
    if (!text) throw new InferenceError('Compatible inference endpoint returned no completion', model.name);
    return text;
  }
  const numGpu = await gpuLayerLimit(model);
  const options: Record<string, unknown> = { temperature: subtitleConfig.temperature, num_ctx: subtitleConfig.contextWindow, num_predict: maxTokens, num_thread: subtitleConfig.cpuThreads };
  if (numGpu !== undefined) options.num_gpu = numGpu;
  const result = await json(await request(endpoint('/api/chat'), {
    model: model.name, stream: false, format: 'json', think: false,
    options,
    messages: [{ role: 'user', content: prompt }],
  }, timeoutMs));
  const message = result.message as { content?: string } | undefined;
  if (!message?.content) throw new InferenceError('Ollama returned no completion', model.name);
  return message.content;
}

async function gpuLayerLimit(model: ModelInfo): Promise<number | undefined> {
  if (gpuLayers.has(model.name)) return gpuLayers.get(model.name);
  try {
    if (!model.size) return undefined;
    const { stdout: vram } = await execFile('nvidia-smi', ['--query-gpu=memory.total', '--format=csv,noheader,nounits'], { timeout: 1500 });
    const totalMiB = Number(vram.trim().split('\n')[0]);
    if (!Number.isFinite(totalMiB) || totalMiB <= 0) return undefined;
    const info = await json(await request(endpoint('/api/show'), { model: model.name }, 10000));
    const modelInfo = info.model_info as Record<string, unknown> | undefined;
    const blocks = Number(Object.entries(modelInfo ?? {}).find(([key]) => key.endsWith('.block_count'))?.[1]);
    if (!Number.isFinite(blocks) || blocks <= 0) return undefined;
    const budgetBytes = totalMiB * 1024 * 1024 * subtitleConfig.gpuUtilization * 0.7;
    const perBlock = model.size / blocks;
    const layers = Math.max(0, Math.min(blocks, Math.floor(budgetBytes / perBlock)));
    gpuLayers.set(model.name, layers);
    return layers;
  } catch { gpuLayers.set(model.name, undefined); return undefined; }
}

export function parseTranslationResponse(raw: string, expected: TranslationCue[], model = 'unknown'): TranslationResult[] {
  const cleaned = raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  let value: unknown;
  try { value = JSON.parse(cleaned); } catch {
    const start = cleaned.indexOf('{'); const end = cleaned.lastIndexOf('}');
    try { value = JSON.parse(cleaned.slice(start, end + 1)); } catch { throw new InferenceError('Model output was not valid JSON', model); }
  }
  const translations = (value as { translations?: unknown })?.translations;
  if (!Array.isArray(translations) || translations.length !== expected.length) throw new InferenceError(`Model returned ${Array.isArray(translations) ? translations.length : 'no'} cues; expected ${expected.length}`, model);
  const expectedIds = new Set(expected.map(cue => cue.id));
  const seen = new Set<string>();
  const entries = translations.map(item => {
    if (!item || typeof item !== 'object' || typeof (item as { id?: unknown }).id !== 'string' || typeof (item as { text?: unknown }).text !== 'string') throw new InferenceError('Model returned a malformed translation record', model);
    const result = item as { id: string; text: string };
    if (!expectedIds.has(result.id) || seen.has(result.id)) throw new InferenceError(`Model returned an unknown or duplicate cue ID: ${result.id}`, model);
    seen.add(result.id);
    return result;
  });
  if (seen.size !== expectedIds.size) throw new InferenceError('Model dropped one or more cue IDs', model);
  const output = entries.map((result): TranslationResult => {
    if (!result.text.trim()) throw new InferenceError(`Model returned an empty translation for ${result.id}`, model);
    return { id: result.id, text: result.text.trim() };
  });
  return output;
}

async function probe(model: ModelInfo, language: SourceLanguage): Promise<boolean> {
  const cached = probeCache.get(model.name);
  if (cached?.[language] !== undefined) return cached[language];
  const sample = language === 'en' ? 'We have to leave now.' : 'おはよう、みんな。';
  try {
    const raw = await complete(model, `Translate this ${language === 'en' ? 'English' : 'Japanese'} anime dialogue line into natural Bulgarian Cyrillic. Return only JSON {"translations":[{"id":"probe","text":"..."}]}: ${JSON.stringify(sample)}`, 120);
    const result = parseTranslationResponse(raw, [{ id: 'probe', text: sample, speaker: null }], model.name)[0]?.text ?? '';
    const supported = /[А-Яа-яЁё]/u.test(result);
    console.log(`Local model probe ${model.name} ${language}: ${supported ? 'supported' : `not detected (${result})`}`);
    const previous = probeCache.get(model.name) ?? {};
    previous[language] = supported;
    probeCache.set(model.name, previous);
    return supported;
  } catch (error) {
    console.warn({ provider: 'local-inference', model: model.name, language, reason: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

export async function modelCoverage(refresh = false): Promise<{ activeModel: string; models: ModelInfo[] }> {
  const models = await availableModels(refresh);
  // DECISION: probe the preferred installed model first and only probe configured fallbacks when needed; probing every large local model serially stalls discovery without improving the selected translation.
  const candidates = subtitleConfig.model
    ? models.filter(model => model.name === subtitleConfig.model)
    : [...models].sort((a, b) => (b.size ?? 0) - (a.size ?? 0)).slice(0, 1);
  if (subtitleConfig.model && !candidates.length) throw new Error(`Configured subtitle model '${subtitleConfig.model}' is not installed`);
  const ranked = [...candidates, ...models.filter(model => subtitleConfig.fallbackModels.includes(model.name) && !candidates.includes(model))];
  let compatible: ModelInfo | undefined;
  for (const model of ranked) {
    const en = await probe(model, 'en');
    const ja = await probe(model, 'ja');
    model.languages = { en, ja };
    if (en && ja && !compatible) compatible = model;
  }
  if (compatible) { selectedModel = compatible.name; return { activeModel: compatible.name, models }; }
  throw new Error(`Installed models did not pass both English→Bulgarian and Japanese→Bulgarian probes (${models.map(model => model.name).join(', ')})`);
}

export async function translateBatch(language: SourceLanguage, cues: TranslationCue[], context: TranslationCue[], glossary: Array<{ source: string; target: string; note?: string }>, alternateModel?: string): Promise<{ model: string; translations: TranslationResult[] }> {
  if (!cues.length) return { model: alternateModel ?? selectedModel ?? '', translations: [] };
  if (!selectedModel || !discovered) await modelCoverage();
  const modelName = alternateModel ?? selectedModel!;
  const model = discovered!.find(item => item.name === modelName);
  if (!model) throw new InferenceError(`Selected model '${modelName}' is not available`, modelName, false);
  if (!await probe(model, language)) throw new InferenceError(`Model '${modelName}' did not pass the ${language}→Bulgarian language probe`, modelName, false);
  const surroundingText = [...cues, ...context].map(cue => cue.text.toLocaleLowerCase()).join('\n');
  const relevantGlossary = glossary.filter(item => item.source && surroundingText.includes(item.source.toLocaleLowerCase()));
  const prompt = promptFor(language, cues, context, relevantGlossary);
  const roughTokens = Math.ceil((prompt.length + 300) / 2.8);
  const maxTokens = Math.min(4000, Math.max(256, Math.ceil(cues.reduce((total, cue) => total + cue.text.length, 0) / 1.2) + 256));
  if (roughTokens + maxTokens > subtitleConfig.maxBatchTokens) throw new InferenceError(`Translation batch estimated at ${roughTokens + maxTokens} tokens, above the configured ceiling ${subtitleConfig.maxBatchTokens}`, modelName);
  if (roughTokens + maxTokens >= subtitleConfig.contextWindow) throw new InferenceError('Translation batch exceeds the configured model context window', modelName);
  const raw = await complete(model, prompt, maxTokens);
  return { model: model.name, translations: parseTranslationResponse(raw, cues, model.name) };
}

export function activeModel(): string | null { return selectedModel ?? (subtitleConfig.model || null); }
