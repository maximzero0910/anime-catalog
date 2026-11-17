import { cpus } from 'node:os';

function integer(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number(process.env[name]);
  return Number.isInteger(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}
function decimal(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

// DECISION: online translation is I/O-bound; two jobs match the provider scheduler's global request cap.
export const subtitleConfig = {
  inferenceUrl: (process.env.SUBTITLE_INFERENCE_URL ?? '').replace(/\/$/, ''),
  ollamaUrl: (process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434').replace(/\/$/, ''),
  model: process.env.SUBTITLE_MODEL ?? '',
  fallbackModels: (process.env.SUBTITLE_FALLBACK_MODELS ?? '').split(',').map(value => value.trim()).filter(Boolean),
  contextWindow: integer('SUBTITLE_CONTEXT_WINDOW', 8192, 2048, 32768),
  gpuUtilization: decimal('SUBTITLE_GPU_UTILIZATION', 0.70, 0, 1),
  maxConcurrentJobs: integer('SUBTITLE_MAX_CONCURRENT', 2, 1, Math.max(1, cpus().length)),
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
  logRetentionDays: integer('SUBTITLE_LOG_RETENTION_DAYS', 180, 7, 3650),
  maxLogRows: integer('SUBTITLE_LOG_MAX_ROWS', 100_000, 1000, 1_000_000),
  dataDirectory: process.env.SUBTITLE_DATA_DIR ?? 'data/subtitles',
  targetLanguage: 'bg',
  translationVersion: '3',
  // DECISION: fixture RTTs ranked the callable adapters SyedGakbar, TranslateSubtitles.co, translate-subtitles.com, then Editsub.
  providerOrder: (process.env.SUBTITLE_PROVIDERS ?? 'syedgakbar,translatesubtitles-co,translate-subtitles-com,editsub,subtitlestranslator').split(',').map(value => value.trim()).filter(Boolean),
  providerTimeoutMs: integer('SUBTITLE_PROVIDER_TIMEOUT_MS', 60_000, 1_000, 60_000),
  providerJobBudgetMs: integer('SUBTITLE_PROVIDER_JOB_BUDGET_MS', 300_000, 1_000, 300_000),
  providerMaxBatchTokens: integer('SUBTITLE_PROVIDER_MAX_BATCH_TOKENS', 2400, 128, 20_000),
  providerGlobalConcurrency: integer('SUBTITLE_PROVIDER_GLOBAL_CONCURRENCY', 2, 1, 2),
  providerRequestsPerWindow: integer('SUBTITLE_PROVIDER_REQUESTS_PER_WINDOW', 1, 1, 20),
  providerWindowMs: integer('SUBTITLE_PROVIDER_WINDOW_MS', 4_000, 4_000, 60_000),
  googleWidgetApiKey: process.env.SUBTITLE_GOOGLE_WIDGET_API_KEY ?? 'AIzaSyATBXajvzQLTDHEQbcpq0Ihe0vWDHmO520',
  googleWidgetUserAgent: process.env.SUBTITLE_GOOGLE_WIDGET_USER_AGENT ?? 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36',
};
