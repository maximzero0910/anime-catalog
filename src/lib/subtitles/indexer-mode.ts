// DECISION: The persistent service drains only durable queued jobs; full-catalog discovery remains an explicit operator mode.
export type SubtitleIndexerMode = 'catalog' | 'queued-only';

export function subtitleIndexerMode(args: readonly string[]): SubtitleIndexerMode {
  return args.includes('--queued-only') ? 'queued-only' : 'catalog';
}
