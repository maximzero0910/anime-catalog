import { cpus } from 'node:os';

function integer(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number(process.env[name]);
  return Number.isInteger(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

export const completedTranslationProviders = ['syedgakbar', 'translatesubtitles-co', 'translate-subtitles-com', 'editsub'] as const;
const supportedProviderIds = new Set<string>(completedTranslationProviders);
export function resolveSubtitleProviderOrder(value = process.env.SUBTITLE_PROVIDERS): string[] {
  const requested = (value ?? '').split(',').map(id => id.trim()).filter(Boolean);
  const completed = [...new Set(requested.filter(id => supportedProviderIds.has(id)))];
  return completed.length ? completed : [...completedTranslationProviders];
}

// DECISION: online translation is I/O-bound; two jobs match the provider scheduler's global request cap.
export const subtitleConfig = {
  // DECISION: Kaggle mode lets the Pi discover and persist source tracks while reserving translation claims for authenticated GPU workers.
  translationMode: process.env.SUBTITLE_TRANSLATION_MODE === 'kaggle' ? 'kaggle' as const : 'online' as const,
  maxConcurrentJobs: integer('SUBTITLE_MAX_CONCURRENT', 2, 1, Math.max(1, cpus().length)),
  retryCount: integer('SUBTITLE_RETRIES', 2, 0, 5),
  queueCap: integer('SUBTITLE_QUEUE_CAP', 100, 1, 10000),
  retryDelayMs: integer('SUBTITLE_RETRY_BASE_MS', 10000, 1000, 3600000),
  // DECISION: keep a small source-discovery reservoir ahead of Kaggle without growing an unbounded queue.
  queueRefillThreshold: integer('SUBTITLE_QUEUE_REFILL_THRESHOLD', 25, 1, 10000),
  queueRefillIntervalMs: integer('SUBTITLE_QUEUE_REFILL_INTERVAL_MS', 30_000, 5_000, 3_600_000),
  // DECISION: workers heartbeat every 15s; a 2m lease detects a dead process promptly while allowing several delayed SQLite writes.
  staleLockMs: integer('SUBTITLE_STALE_LOCK_MS', 2 * 60_000, 60_000, 24 * 60 * 60_000),
  indexStaleLockMs: integer('SUBTITLE_INDEX_STALE_LOCK_MS', 2 * 60_000, 60_000, 24 * 60 * 60_000),
  logRetentionDays: integer('SUBTITLE_LOG_RETENTION_DAYS', 180, 7, 3650),
  maxLogRows: integer('SUBTITLE_LOG_MAX_ROWS', 100_000, 1000, 1_000_000),
  dataDirectory: process.env.SUBTITLE_DATA_DIR ?? 'data/subtitles',
  targetLanguage: 'bg',
  translationVersion: '3',
  // DECISION: unknown and retired providers are filtered so stale env values cannot restore local inference or an unverified adapter.
  providerOrder: resolveSubtitleProviderOrder(),
  providerTimeoutMs: integer('SUBTITLE_PROVIDER_TIMEOUT_MS', 60_000, 1_000, 60_000),
  providerJobBudgetMs: integer('SUBTITLE_PROVIDER_JOB_BUDGET_MS', 300_000, 1_000, 300_000),
  providerMaxBatchTokens: integer('SUBTITLE_PROVIDER_MAX_BATCH_TOKENS', 2400, 128, 20_000),
  providerGlobalConcurrency: integer('SUBTITLE_PROVIDER_GLOBAL_CONCURRENCY', 2, 1, 2),
  providerRequestsPerWindow: integer('SUBTITLE_PROVIDER_REQUESTS_PER_WINDOW', 1, 1, 20),
  providerWindowMs: integer('SUBTITLE_PROVIDER_WINDOW_MS', 4_000, 4_000, 60_000),
  googleWidgetApiKey: process.env.SUBTITLE_GOOGLE_WIDGET_API_KEY ?? 'AIzaSyATBXajvzQLTDHEQbcpq0Ihe0vWDHmO520',
  googleWidgetUserAgent: process.env.SUBTITLE_GOOGLE_WIDGET_USER_AGENT ?? 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36',
};
