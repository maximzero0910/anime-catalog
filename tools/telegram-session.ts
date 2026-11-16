import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { loadEnvFile } from 'node:process';
import { chmod, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';

const envPath = '.env';
if (!existsSync(envPath)) throw new Error('Create the project-root .env file with TG_API_ID and TG_API_HASH first.');
loadEnvFile(envPath);
const apiId = Number(process.env.TG_API_ID ?? process.env.TELEGRAM_API_ID);
const apiHash = process.env.TG_API_HASH ?? process.env.TELEGRAM_API_HASH ?? '';
if (!Number.isSafeInteger(apiId) || apiId <= 0 || apiHash.length < 32) throw new Error('TG_API_ID or TG_API_HASH is missing or invalid in .env.');

const terminal = createInterface({ input: stdin, output: stdout });
const stringSession = new StringSession('');
const client = new TelegramClient(stringSession, apiId, apiHash, { connectionRetries: 5, requestRetries: 2, autoReconnect: false });
let enteredPhone = '';
let authErrorReported = false;
const safeError = (error: unknown): string => {
  const details = error as { errorMessage?: unknown; message?: unknown; code?: unknown };
  let message = String(details?.errorMessage ?? details?.message ?? error ?? 'unknown Telegram error').replace(/[\r\n\t]+/g, ' ').slice(0, 300);
  for (const secret of [enteredPhone, process.env.TG_API_HASH, process.env.TG_SESSION, process.env.TG_CHANNEL]) {
    if (secret) message = message.split(secret).join('[redacted]');
  }
  return details?.code ? `${String(details.code)}: ${message}` : message;
};
try {
  console.info('Telegram will send a one-time sign-in code to your account. Enter it only in this terminal prompt.');
  await client.start({
    phoneNumber: async () => { enteredPhone = await terminal.question('Telegram phone number (international format): '); return enteredPhone; },
    phoneCode: () => terminal.question('Telegram sign-in code: '),
    password: () => terminal.question('Telegram two-step verification password (if enabled): '),
    onError: async error => { authErrorReported = true; console.error(`Telegram rejected the sign-in attempt: ${safeError(error)}`); return true; },
  });
  const session = stringSession.save();
  if (session.length < 50) throw new Error('GramJS returned an invalid session string; it was not saved.');
  const source = await readFile(envPath, 'utf8');
  const lines = source.split(/\r?\n/);
  let replaced = false;
  const output = lines.flatMap(line => {
    if (!/^\s*(?:export\s+)?TG_SESSION\s*=/.test(line)) return [line];
    if (replaced) return [];
    replaced = true;
    return [`TG_SESSION=${JSON.stringify(session)}`];
  });
  if (!replaced) output.push(`TG_SESSION=${JSON.stringify(session)}`);
  const tempPath = `${envPath}.tmp`;
  await writeFile(tempPath, output.join('\n').replace(/\n*$/, '\n'), { mode: 0o600 });
  await chmod(tempPath, 0o600);
  await rename(tempPath, envPath);
  await chmod(envPath, 0o600);
  console.info('Telegram account authorized. TG_SESSION was saved privately to .env; the session value was not printed.');
} catch (error) {
  if (!authErrorReported) console.error(`GramJS login failed: ${safeError(error)}`);
  process.exitCode = 1;
} finally {
  terminal.close();
  await client.disconnect().catch(() => undefined);
}

