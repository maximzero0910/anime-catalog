import { createHash } from 'node:crypto';
import { subtitleConfig } from '../config';
import { persistSubtitleProviderState, subtitleProviderStates } from '../storage';

export type SubtitleFormat = 'srt' | 'vtt';
export type Provider = {
  id: string;
  kind: 'http' | 'browser';
  accepts: SubtitleFormat[];
  maxBytes: number;
  maxCues: number;
  translate(input: { srt: string; sourceLang: string; targetLang: string }, signal: AbortSignal): Promise<string>;
  health(): { ok: boolean; cooldownUntil: number };
};
export type ProviderFailureKind = 'network' | 'blocked' | 'empty' | 'parse' | 'timeout' | 'rate-limit' | 'unavailable' | 'validation' | 'quality';
export class ProviderError extends Error {
  constructor(readonly provider: string, readonly kind: ProviderFailureKind, message: string) { super(message); this.name = 'ProviderError'; }
}

interface SrtCue { id: string; start: string; end: string; text: string; }
interface SrtDocument { format: SubtitleFormat; header: string; cues: SrtCue[]; }
interface ProviderMetrics { attempts: number; successes: number; failures: number; consecutiveFailures: number; cooldownUntil: number; disabledThisRun: boolean; lastLatencyMs: number | null; lastError: string | null; lastStatus: number | null; }
const registrations = new Map<string, Provider>();
export const translationProviders = registrations;
const runId = `${process.pid}:${Date.now()}`;
const savedStates = subtitleProviderStates();
const metrics = new Map<string, ProviderMetrics>();
for (const [id, state] of Object.entries(savedStates)) {
  metrics.set(id, {
    attempts: Number(state.attempts) || 0, successes: Number(state.successes) || 0, failures: Number(state.failures) || 0,
    consecutiveFailures: Number(state.consecutiveFailures) || 0, cooldownUntil: Number(state.cooldownUntil) || 0,
    disabledThisRun: false, lastLatencyMs: typeof state.lastLatencyMs === 'number' ? state.lastLatencyMs : null,
    lastError: typeof state.lastError === 'string' ? state.lastError : null, lastStatus: typeof state.lastStatus === 'number' ? state.lastStatus : null,
  });
}
const providerState = (id: string): ProviderMetrics => {
  let state = metrics.get(id);
  if (!state) {
    state = { attempts: 0, successes: 0, failures: 0, consecutiveFailures: 0, cooldownUntil: 0, disabledThisRun: false, lastLatencyMs: null, lastError: null, lastStatus: null };
    metrics.set(id, state);
  }
  return state;
};
function persistState(id: string): void {
  const state = providerState(id);
  persistSubtitleProviderState(id, { ...state, runId });
}
export function register(provider: Provider): void {
  if (!provider.id.trim()) throw new Error('Subtitle provider id cannot be empty');
  registrations.set(provider.id, provider);
  providerState(provider.id);
}
export function isOpen(id: string): boolean {
  const provider = registrations.get(id);
  if (!provider) return true;
  const health = provider.health();
  return !health.ok || health.cooldownUntil > Date.now() || providerState(id).disabledThisRun;
}
export function nextProviderAvailableAt(now = Date.now()): number | null {
  const times = ordered().map(provider => {
    const health = provider.health();
    const state = providerState(provider.id);
    if (!health.ok || state.disabledThisRun) return null;
    const availableAt = Math.max(health.cooldownUntil, state.cooldownUntil);
    return availableAt > now ? availableAt : now;
  }).filter((value): value is number => value !== null);
  return times.length ? Math.min(...times) : null;
}
export function recordSuccess(id: string, latencyMs = 0, status: number | null = 200): void {
  const state = providerState(id);
  state.attempts++; state.successes++; state.consecutiveFailures = 0; state.lastLatencyMs = Math.max(0, latencyMs); state.lastError = null; state.lastStatus = status;
  persistState(id);
}
export function recordFailure(id: string, reason: string, latencyMs = 0, status: number | null = null): void {
  const state = providerState(id);
  state.attempts++; state.failures++; state.consecutiveFailures++; state.lastLatencyMs = Math.max(0, latencyMs); state.lastError = reason.slice(0, 500); state.lastStatus = status;
  state.cooldownUntil = Date.now() + Math.min(6 * 60 * 60_000, 5 * 60_000 * (2 ** state.consecutiveFailures));
  if (state.consecutiveFailures >= 3) state.disabledThisRun = true;
  persistState(id);
}
export function recordQualityRejection(id: string, reason: string, latencyMs = 0): void {
  const state = providerState(id);
  state.attempts++; state.failures++; state.lastLatencyMs = Math.max(0, latencyMs); state.lastError = reason.slice(0, 500); state.lastStatus = null;
  // A usable HTTP response with imperfect translation is not a provider outage.
  persistState(id);
}
export function ordered(): Provider[] {
  const configured = [...new Set(subtitleConfig.providerOrder)];
  const result = configured.map(id => registrations.get(id)).filter((provider): provider is Provider => Boolean(provider));
  return result;
}
export function providerStatus(): Array<Record<string, unknown>> {
  const persisted = subtitleProviderStates();
  for (const [id, stored] of Object.entries(persisted)) {
    const sameRun = stored.runId === runId;
    metrics.set(id, {
      attempts: Number(stored.attempts) || 0, successes: Number(stored.successes) || 0, failures: Number(stored.failures) || 0,
      consecutiveFailures: Number(stored.consecutiveFailures) || 0, cooldownUntil: Number(stored.cooldownUntil) || 0,
      disabledThisRun: sameRun && stored.disabledThisRun === true,
      lastLatencyMs: typeof stored.lastLatencyMs === 'number' ? stored.lastLatencyMs : null,
      lastError: typeof stored.lastError === 'string' ? stored.lastError : null,
      lastStatus: typeof stored.lastStatus === 'number' ? stored.lastStatus : null,
    });
  }
  return ordered().map(provider => {
    const state = providerState(provider.id);
    const healthy = provider.health();
    const configured = subtitleConfig.providerOrder.includes(provider.id);
    return {
      id: provider.id, kind: provider.kind, enabled: configured && healthy.ok && !state.disabledThisRun,
      cooldownUntil: Math.max(healthy.cooldownUntil, state.cooldownUntil), cooldownRemainingMs: Math.max(0, Math.max(healthy.cooldownUntil, state.cooldownUntil) - Date.now()),
      attempts: state.attempts, successes: state.successes, failures: state.failures,
      successRate: state.attempts ? state.successes / state.attempts : null, lastLatencyMs: state.lastLatencyMs,
      lastError: state.lastError, lastStatus: state.lastStatus, disabledThisRun: state.disabledThisRun,
      accepts: provider.accepts, maxBytes: provider.maxBytes, maxCues: provider.maxCues,
    };
  });
}

const timePattern = '((?:\\d{2}:)?\\d{2}:\\d{2}[,.]\\d{1,3})';
const timingPattern = new RegExp(`^\\s*${timePattern}\\s*-->\\s*${timePattern}(?:\\s+.*)?$`);
function timestampMs(value: string): number {
  const parts = value.replace(',', '.').split(':');
  const seconds = Number(parts.pop());
  const minutes = Number(parts.pop());
  const hours = Number(parts.pop() ?? 0);
  return ((hours * 60 + minutes) * 60 + seconds) * 1000;
}
function parseSrt(input: string, provider: string): SrtDocument {
  const raw = input.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const format: SubtitleFormat = /^\s*WEBVTT(?:\s|$)/i.test(raw) ? 'vtt' : 'srt';
  const split = raw.split(/\n[ \t]*\n/);
  let header = '';
  const cues: SrtCue[] = [];
  for (const block of split) {
    const lines = block.split('\n');
    const index = lines.findIndex(line => timingPattern.test(line));
    if (index < 0) {
      if (format === 'vtt' && !header && lines.some(line => /^WEBVTT(?:\s|$)/i.test(line.trim()))) header = block.trim();
      continue;
    }
    const match = lines[index]!.match(timingPattern);
    if (!match) continue;
    const text = lines.slice(index + 1).join('\n').trim();
    const idLine = lines[index - 1]?.trim();
    const id = idLine && idLine !== 'WEBVTT' && !timingPattern.test(idLine) ? idLine : String(cues.length + 1);
    cues.push({ id, start: match[1]!, end: match[2]!, text });
  }
  if (!cues.length) throw new ProviderError(provider, 'parse', 'input has no valid subtitle cues');
  if (cues.some(cue => !cue.text.trim())) throw new ProviderError(provider, 'parse', 'input contains an empty cue');
  return { format, header: format === 'vtt' ? header || 'WEBVTT' : '', cues };
}
function serializeSrt(document: SrtDocument, cues = document.cues): string {
  const body = cues.map((cue, index) => `${document.format === 'vtt' ? cue.id : index + 1}\n${cue.start} --> ${cue.end}\n${cue.text}`).join('\n\n');
  return `${document.format === 'vtt' ? `${document.header}\n\n` : ''}${body}\n`;
}
interface SavedTag { tag: string; fraction: number; order: number; }
function stripTags(text: string): { text: string; tags: SavedTag[] } {
  const tags: SavedTag[] = [];
  const pattern = /<[^>]+>|\{[^}]*\}/g;
  let result = '';
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    const prefix = text.slice(last, index);
    result += prefix;
    tags.push({ tag: match[0], fraction: (result.length / Math.max(1, text.replace(pattern, '').length)), order: tags.length });
    last = index + match[0].length;
  }
  result += text.slice(last);
  return { text: result.trim(), tags };
}
function restoreTags(text: string, tags: SavedTag[]): string {
  if (!tags.length) return text;
  const insertions = tags.map(item => ({ ...item, index: Math.max(0, Math.min(text.length, Math.round(item.fraction * text.length))) })).sort((a, b) => a.index - b.index || a.order - b.order);
  let output = ''; let cursor = 0;
  for (const insertion of insertions) { output += text.slice(cursor, insertion.index) + insertion.tag; cursor = insertion.index; }
  return output + text.slice(cursor);
}
function estimateTokens(text: string): number { return Math.ceil(text.length / 3.25) + 12; }
function chunkForProvider(document: SrtDocument, provider: Provider): SrtCue[][] {
  const chunks: SrtCue[][] = [];
  let cursor = 0;
  while (cursor < document.cues.length) {
    const overlap = cursor > 0 ? document.cues[cursor - 1]! : undefined;
    const available = Math.max(1, provider.maxCues - (overlap ? 1 : 0));
    const selected: SrtCue[] = [];
    let tokens = overlap ? estimateTokens(overlap.text) : 0;
    for (let i = cursor; i < document.cues.length && selected.length < available; i++) {
      const cue = document.cues[i]!;
      const clean = stripTags(cue.text).text;
      const cost = estimateTokens(clean);
      if (selected.length && tokens + cost > subtitleConfig.providerMaxBatchTokens) break;
      if (!selected.length && tokens + cost > subtitleConfig.providerMaxBatchTokens) throw new ProviderError(provider.id, 'validation', `cue ${i + 1} exceeds the provider batch token ceiling`);
      selected.push(cue); tokens += cost;
    }
    if (!selected.length) throw new ProviderError(provider.id, 'validation', 'batch could not advance');
    chunks.push(overlap ? [overlap, ...selected] : selected);
    cursor += selected.length;
  }
  return chunks;
}
function assertProviderOutput(provider: Provider, input: SrtCue[], output: SrtDocument): void {
  if (output.cues.length !== input.length) throw new ProviderError(provider.id, 'validation', `cue parity failed: input=${input.length}, output=${output.cues.length}`);
  for (let i = 0; i < input.length; i++) {
    if (timestampMs(output.cues[i]!.start) !== timestampMs(input[i]!.start) || timestampMs(output.cues[i]!.end) !== timestampMs(input[i]!.end)) throw new ProviderError(provider.id, 'validation', `timestamp mismatch at cue ${i + 1}`);
  }
}
function assertBulgarianOutput(provider: Provider, cues: SrtCue[]): void {
  const empty = cues.filter(cue => !cue.text.trim()).length;
  if (empty / Math.max(1, cues.length) > 0.2) throw new ProviderError(provider.id, 'validation', `more than 20% empty cues (${empty}/${cues.length})`);
  const text = cues.map(cue => cue.text.replace(/<[^>]+>|\{[^}]*\}/g, '')).join(' ');
  const letters = text.match(/\p{L}/gu) ?? [];
  const cyrillic = text.match(/\p{Script=Cyrillic}/gu) ?? [];
  if (!letters.length || cyrillic.length / letters.length < 0.5) throw new ProviderError(provider.id, 'validation', `Cyrillic letter ratio ${letters.length ? (cyrillic.length / letters.length).toFixed(2) : '0.00'} is below 0.50`);
}

let activeHttp = 0;
const waitingForHttp: Array<() => void> = [];
async function acquireGlobalSlot(signal: AbortSignal): Promise<() => void> {
  if (signal.aborted) throw new ProviderError('chain', 'timeout', 'request aborted before starting');
  if (activeHttp >= subtitleConfig.providerGlobalConcurrency) await new Promise<void>((resolve, reject) => {
    const abort = () => { const index = waitingForHttp.indexOf(wake); if (index >= 0) waitingForHttp.splice(index, 1); reject(new ProviderError('chain', 'timeout', 'aborted while waiting for provider slot')); };
    const wake = () => { signal.removeEventListener('abort', abort); resolve(); };
    waitingForHttp.push(wake); signal.addEventListener('abort', abort, { once: true });
  });
  else activeHttp++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = waitingForHttp.shift();
    if (next) next(); else activeHttp = Math.max(0, activeHttp - 1);
  };
}
const nextAllowedAt = new Map<string, number>();
async function waitForProviderToken(provider: Provider, signal: AbortSignal): Promise<void> {
  const now = Date.now();
  const next = nextAllowedAt.get(provider.id) ?? 0;
  const spacingMs = Math.ceil(subtitleConfig.providerWindowMs / subtitleConfig.providerRequestsPerWindow);
  const slot = Math.max(now, next);
  nextAllowedAt.set(provider.id, slot + spacingMs);
  const delay = slot - now;
  if (delay <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, delay);
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new ProviderError(provider.id, 'timeout', 'aborted while waiting for provider token')); };
    function done() { signal.removeEventListener('abort', abort); resolve(); }
    signal.addEventListener('abort', abort, { once: true });
  });
}
async function invokeProvider(provider: Provider, input: { srt: string; sourceLang: string; targetLang: string }, outerSignal: AbortSignal): Promise<{ text: string; latencyMs: number }> {
  // Rate-limit waits must not occupy a scarce global network slot.
  await waitForProviderToken(provider, outerSignal);
  const release = await acquireGlobalSlot(outerSignal);
  const started = Date.now();
  const controller = new AbortController();
  const abort = () => controller.abort(outerSignal.reason);
  outerSignal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('provider attempt timed out')), subtitleConfig.providerTimeoutMs);
  try {
    const text = await provider.translate(input, controller.signal);
    return { text, latencyMs: Date.now() - started };
  } catch (error) {
    if (controller.signal.aborted) throw new ProviderError(provider.id, 'timeout', 'provider attempt timed out or was aborted');
    if (error instanceof ProviderError) throw error;
    throw new ProviderError(provider.id, 'network', error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timer); outerSignal.removeEventListener('abort', abort); release();
  }
}

export async function translateWithProvider(provider: Provider, srt: string, sourceLang: string, targetLang: string, signal: AbortSignal): Promise<{ srt: string; cueCount: number }> {
  if (!provider.accepts.includes('srt')) throw new ProviderError(provider.id, 'unavailable', 'provider does not accept SRT');
  const inputBytes = Buffer.byteLength(srt, 'utf8');
  if (inputBytes > provider.maxBytes) throw new ProviderError(provider.id, 'validation', `SRT size ${inputBytes} exceeds ${provider.maxBytes} bytes`);
  if (!sourceLang.trim()) throw new ProviderError(provider.id, 'validation', 'source language must be explicit');
  const document = parseSrt(srt, provider.id);
  if (document.cues.length > provider.maxCues && provider.maxCues < 2) throw new ProviderError(provider.id, 'validation', `provider cue ceiling ${provider.maxCues} is too small for overlap batching`);
  const output: SrtCue[] = [];
  for (const batch of chunkForProvider(document, provider)) {
    const stripped = batch.map(cue => stripTags(cue.text));
    const cleanBatch = batch.map((cue, index) => ({ ...cue, start: cue.start.replace('.', ','), end: cue.end.replace('.', ','), text: stripped[index]!.text }));
    const requestDoc: SrtDocument = { format: 'srt', header: '', cues: cleanBatch };
    const request = serializeSrt(requestDoc, cleanBatch);
    const { text } = await invokeProvider(provider, { srt: request, sourceLang, targetLang }, signal);
    const response = parseSrt(text, provider.id);
    assertProviderOutput(provider, cleanBatch, response);
    const isOverlap = output.length > 0;
    for (let index = isOverlap ? 1 : 0; index < response.cues.length; index++) {
      const local = index;
      const originalIndex = batch[local]!;
      const source = stripped[local]!;
      output.push({ ...originalIndex, text: restoreTags(response.cues[index]!.text, source.tags) });
    }
  }
  if (output.length !== document.cues.length) throw new ProviderError(provider.id, 'validation', `merged cue count mismatch: input=${document.cues.length}, output=${output.length}`);
  assertBulgarianOutput(provider, output);
  return { srt: serializeSrt(document, output), cueCount: output.length };
}

function providerInput(srt: string, provider: string): { document: SrtDocument; texts: string[] } {
  const document = parseSrt(srt, provider);
  const texts = document.cues.map(cue => cue.text);
  return { document, texts };
}
function withTranslations(provider: string, srt: string, translated: string[]): string {
  const document = parseSrt(srt, provider);
  if (translated.length !== document.cues.length) throw new ProviderError(provider, 'validation', `translation returned ${translated.length} lines for ${document.cues.length} cues`);
  return serializeSrt(document, document.cues.map((cue, index) => ({ ...cue, text: translated[index] ?? '' })));
}
async function googleWidgetTranslate(provider: string, referer: string, input: { srt: string; sourceLang: string; targetLang: string }, signal: AbortSignal): Promise<string> {
  const { document, texts } = providerInput(input.srt, provider);
  const response = await fetch('https://translate-pa.googleapis.com/v1/translateHtml', {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json+protobuf', 'X-goog-api-key': subtitleConfig.googleWidgetApiKey, Referer: referer, 'User-Agent': subtitleConfig.googleWidgetUserAgent },
    body: JSON.stringify([[texts, input.sourceLang, input.targetLang], 'te']),
  });
  if (response.status === 429) throw new ProviderError(provider, 'rate-limit', `Google widget returned HTTP ${response.status}`);
  if (response.status === 403) throw new ProviderError(provider, 'blocked', 'Google widget returned HTTP 403');
  if (!response.ok) throw new ProviderError(provider, response.status >= 500 ? 'network' : 'blocked', `Google widget returned HTTP ${response.status}`);
  const payload: unknown = await response.json();
  const findTextArray = (value: unknown): string[] | undefined => {
    if (Array.isArray(value) && value.length === document.cues.length && value.every(line => typeof line === 'string')) return value as string[];
    if (Array.isArray(value)) for (const item of value) { const found = findTextArray(item); if (found) return found; }
    return undefined;
  };
  const translated = findTextArray(payload) ?? [];
  if (translated.length !== document.cues.length) throw new ProviderError(provider, 'parse', `Google widget response parity failed: expected=${document.cues.length}, got=${translated.length}`);
  return withTranslations(provider, input.srt, translated);
}
function widgetProvider(id: string, referer: string): Provider {
  return {
    id, kind: 'http', accepts: ['srt', 'vtt'], maxBytes: 1_048_576, maxCues: 40,
    translate: (input, signal) => googleWidgetTranslate(id, referer, input, signal),
    health: () => ({ ok: Boolean(subtitleConfig.googleWidgetApiKey) && !providerState(id).disabledThisRun, cooldownUntil: providerState(id).cooldownUntil }),
  };
}
function encodeEditsub(text: string): string {
  const mask = [...new TextEncoder().encode('editsub.')].reduce((result, byte) => result ^ byte, 0);
  return [...new TextEncoder().encode(text)].map(byte => (byte ^ mask).toString(16).padStart(2, '0')).join('');
}
const editsub: Provider = {
  id: 'editsub', kind: 'http', accepts: ['srt', 'vtt'], maxBytes: 1_048_576, maxCues: 40,
  async translate(input, signal) {
    const { document, texts } = providerInput(input.srt, this.id);
    const response = await fetch('https://editsub.com/api/translate', {
      method: 'POST', signal, headers: { 'Content-Type': 'application/json', Origin: 'https://editsub.com', Referer: 'https://editsub.com/translate' },
      body: JSON.stringify({ texts: texts.map(encodeEditsub), to: input.targetLang, from: input.sourceLang }),
    });
    if (response.status === 429) throw new ProviderError(this.id, 'rate-limit', 'Editsub returned HTTP 429');
    if (response.status === 403) throw new ProviderError(this.id, 'blocked', 'Editsub returned HTTP 403');
    if (!response.ok) throw new ProviderError(this.id, response.status >= 500 ? 'network' : 'blocked', `Editsub returned HTTP ${response.status}`);
    const body = await response.json() as { translatedText?: unknown };
    if (!Array.isArray(body.translatedText) || body.translatedText.some(line => typeof line !== 'string')) throw new ProviderError(this.id, 'parse', 'Editsub response has no translatedText string array');
    const translated = body.translatedText as string[];
    if (translated.length !== document.cues.length) throw new ProviderError(this.id, 'parse', `Editsub response parity failed: expected=${document.cues.length}, got=${translated.length}`);
    return withTranslations(this.id, input.srt, translated);
  },
  health: () => ({ ok: !providerState('editsub').disabledThisRun, cooldownUntil: providerState('editsub').cooldownUntil }),
};
register(widgetProvider('translatesubtitles-co', 'https://translatesubtitles.co/'));
register(widgetProvider('translate-subtitles-com', 'https://translate-subtitles.com/'));
register(widgetProvider('syedgakbar', 'https://www.syedgakbar.com/'));
register(editsub);

export interface ProviderTranslateResult { providerId: string; srt: string; cacheHit: boolean; latencyMs: number; }
export async function translateThroughProviders(input: { srt: string; sourceLang: string; targetLang: string }, options: {
  signal?: AbortSignal; totalBudgetMs?: number; getCached?: (providerId: string) => Promise<string | undefined>;
  onSuccess?: (providerId: string, srt: string, latencyMs: number, cacheHit: boolean) => Promise<void>;
  onFailure?: (providerId: string, reason: string) => void;
} = {}): Promise<ProviderTranslateResult> {
  const controller = new AbortController();
  const parentAbort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) parentAbort();
  else options.signal?.addEventListener('abort', parentAbort, { once: true });
  const started = Date.now();
  const deadline = started + (options.totalBudgetMs ?? subtitleConfig.providerJobBudgetMs);
  const budgetTimer = setTimeout(() => controller.abort(new Error('subtitle provider-chain budget exhausted')), Math.max(0, deadline - Date.now()));
  try {
    for (const provider of ordered()) {
      if (controller.signal.aborted) throw new ProviderError(provider.id, 'timeout', 'translation job was aborted');
      if (Date.now() >= deadline) {
        options.onFailure?.(provider.id, '300-second provider-chain budget exhausted');
        break;
      }
      if (isOpen(provider.id)) continue;
      const cached = await options.getCached?.(provider.id);
      if (cached) {
        await options.onSuccess?.(provider.id, cached, 0, true);
        return { providerId: provider.id, srt: cached, cacheHit: true, latencyMs: 0 };
      }
      const attemptStarted = Date.now();
      try {
        const result = await translateWithProvider(provider, input.srt, input.sourceLang, input.targetLang, controller.signal);
        const elapsed = Date.now() - attemptStarted;
        await options.onSuccess?.(provider.id, result.srt, elapsed, false);
        recordSuccess(provider.id, elapsed);
        return { providerId: provider.id, srt: result.srt, cacheHit: false, latencyMs: elapsed };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (error instanceof ProviderError && error.kind === 'quality') recordQualityRejection(provider.id, reason, Date.now() - attemptStarted);
        else recordFailure(provider.id, reason, Date.now() - attemptStarted);
        options.onFailure?.(provider.id, reason);
      }
    }
    throw new ProviderError('chain', 'empty', 'all subtitle providers were exhausted');
  } finally {
    clearTimeout(budgetTimer);
    options.signal?.removeEventListener('abort', parentAbort);
  }
}

export function providerMetricsSnapshot(): Record<string, Record<string, unknown>> { return Object.fromEntries([...metrics.entries()].map(([id, state]) => [id, { ...state }])); }
