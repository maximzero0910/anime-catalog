import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const scriptPath = new URL('../../deploy/systemd/anineko-recover-failed', import.meta.url);

test('recovery script only resets and starts allowlisted failed services', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'anineko-systemd-recovery-'));
  try {
    const log = path.join(directory, 'calls.log');
    const systemctl = path.join(directory, 'systemctl');
    const logger = path.join(directory, 'logger');
    writeFileSync(systemctl, `#!/bin/sh
printf '%s\\n' "$*" >> "$RECOVERY_CALL_LOG"
if [ "$1" = is-failed ]; then
  [ "$3" = "$FAILED_UNIT" ]
  exit $?
fi
exit 0
`);
    writeFileSync(logger, '#!/bin/sh\nexit 0\n');
    chmodSync(systemctl, 0o755);
    chmodSync(logger, 0o755);

    const result = spawnSync('/bin/sh', [scriptPath.pathname], {
      env: { ...process.env, PATH: directory, RECOVERY_CALL_LOG: log, FAILED_UNIT: 'anineko-subtitles-worker.service' },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(log, 'utf8'), [
      'is-failed --quiet anineko-web.service',
      'is-failed --quiet anineko-subtitles-worker.service',
      'reset-failed anineko-subtitles-worker.service',
      'start anineko-subtitles-worker.service',
      'is-failed --quiet anineko-subtitles-indexer.service',
      'is-failed --quiet anineko-telegram-sync.service',
    ].join('\n') + '\n');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('recovery script does not start inactive services or accept arbitrary unit names', () => {
  const source = readFileSync(scriptPath, 'utf8');
  assert.match(source, /for unit in anineko-web\.service anineko-subtitles-worker\.service anineko-subtitles-indexer\.service anineko-telegram-sync\.service/);
  assert.doesNotMatch(source, /\$1|\$\{1\}|read -r unit/);
});
