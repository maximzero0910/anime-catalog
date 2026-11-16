import { cpus, freemem, totalmem } from 'node:os';

function integer(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number(process.env[name]);
  return Number.isInteger(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}
function decimal(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

// DECISION: keep one translation in flight by default because the installed 27B model is larger than available VRAM.
export const subtitleConfig = {
  inferenceUrl: (process.env.SUBTITLE_INFERENCE_URL ?? '').replace(/\/$/, ''),
  ollamaUrl: (process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434').replace(/\/$/, ''),
  model: process.env.SUBTITLE_MODEL ?? '',
  fallbackModels: (process.env.SUBTITLE_FALLBACK_MODELS ?? '').split(',').map(value => value.trim()).filter(Boolean),
  contextWindow: integer('SUBTITLE_CONTEXT_WINDOW', 8192, 2048, 32768),
  gpuUtilization: decimal('SUBTITLE_GPU_UTILIZATION', 0.70, 0, 1),
  maxConcurrentJobs: integer('SUBTITLE_MAX_CONCURRENT', 1, 1, Math.max(1, cpus().length)),
  batchSize: integer('SUBTITLE_BATCH_SIZE', 4, 1, 40),
  maxBatchTokens: integer('SUBTITLE_MAX_BATCH_TOKENS', 3600, 256, 20000),
  contextOverlap: integer('SUBTITLE_CONTEXT_OVERLAP', 3, 0, 10),
  temperature: decimal('SUBTITLE_TEMPERATURE', 0.15, 0, 1),
  timeoutMs: integer('SUBTITLE_TIMEOUT_MS', 600000, 10000, 600000),
  retryCount: integer('SUBTITLE_RETRIES', 2, 0, 5),
  cpuThreads: integer('SUBTITLE_CPU_THREADS', Math.max(1, Math.min(6, cpus().length)), 1, 32),
  ramCeiling: decimal('SUBTITLE_RAM_CEILING', 0.85, 0.2, 0.95),
  queueCap: integer('SUBTITLE_QUEUE_CAP', 100, 1, 10000),
  retryDelayMs: integer('SUBTITLE_RETRY_BASE_MS', 10000, 1000, 3600000),
  staleLockMs: integer('SUBTITLE_STALE_LOCK_MS', 30 * 60_000, 60_000, 24 * 60 * 60_000),
  dataDirectory: process.env.SUBTITLE_DATA_DIR ?? 'data/subtitles',
  targetLanguage: 'bg',
  translationVersion: '3',
};

export function memoryBudgetAvailable(): boolean {
  return totalmem() === 0 || freemem() / totalmem() >= 1 - subtitleConfig.ramCeiling;
}
