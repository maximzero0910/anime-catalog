import { setTimeout as delay } from 'node:timers/promises';
import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { startWorkerHeartbeat } from '../src/lib/worker-heartbeat';

if (existsSync('.env')) loadEnvFile('.env');
const [{ synchronizeTelegramChannel, telegramConfigured, disconnectTelegramClient }, { telegramStats, telegramSyncLeaseActive, updateTelegramSyncState }] = await Promise.all([
  import('../src/lib/telegram/client'), import('../src/lib/telegram/storage'),
]);

const once = process.argv.includes('--once');
const watch = process.argv.includes('--watch');
const stopApplicationHeartbeat = startWorkerHeartbeat('telegram-sync');
let stopping = false;
const stopController = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { stopping = true; stopController.abort(); });
if (!telegramConfigured()) {
  updateTelegramSyncState({ status: 'unconfigured', lastError: 'Set TG_API_ID, TG_API_HASH, TG_SESSION, and TG_CHANNEL on the server' });
  console.error('Telegram sync not started: required TG_API_ID, TG_API_HASH, TG_SESSION, TG_CHANNEL configuration is missing.');
  process.exitCode = 2;
} else {
if (watch && telegramStats().status === 'syncing' && !telegramSyncLeaseActive()) updateTelegramSyncState({ status: 'queued', lastError: 'Recovered interrupted sync after worker restart' });
  let nextPollAt = 0;
  let failures = 0;
  do {
    try {
      const queued = telegramStats().status === 'queued';
      if (once || queued || !watch || Date.now() >= nextPollAt) {
        const result = await synchronizeTelegramChannel(stopController.signal);
        console.info({ event: 'telegram_sync_complete', ...result });
        failures = 0;
        nextPollAt = Date.now() + 60_000;
      }
    } catch (error) {
      if (stopping) break;
      console.error({ event: 'telegram_sync_failed', reason: error instanceof Error ? error.message : String(error) });
      failures++;
      nextPollAt = Date.now() + Math.min(10 * 60_000, 5000 * (2 ** Math.min(failures - 1, 7))) + Math.random() * 3000;
      if (!watch) { process.exitCode = 1; break; }
    }
    if (!watch || stopping) break;
    await delay(Math.max(250, Math.min(2000, nextPollAt - Date.now())));
  } while (!stopping);
  if (stopping) updateTelegramSyncState({ status: 'idle', lastError: null });
}
await disconnectTelegramClient();
stopApplicationHeartbeat();

