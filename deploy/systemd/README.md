# systemd service templates

These are **proposed templates**, not installed Pi configuration. They use the existing standalone Astro output and the existing subtitle and Telegram worker entry points. The Node API listens on loopback only. The services have bounded restart bursts and cgroup resource ceilings. The recovery timer checks only these three allowlisted services every ten minutes and resets/starts one only when systemd reports it in `failed` state. This bounds crash-loop retries to at most one recovery attempt per timer interval after the normal restart burst; failures are logged to the system journal.

Before installing, review the executable paths and confirm the Pi's systemd supports `MemoryHigh`, `MemoryMax`, `CPUQuota`, `TasksMax`, and the listed sandbox options. Install a release under `/opt/anineko/current`, owned read-only by `anineko`, ensure runtime dependencies include `tsx` for the TypeScript tools, and create `/srv/anineko` on the intended persistent filesystem with ownership `anineko:anineko`. Put the service environment in root-owned `/etc/anineko/anineko.env` with mode `0600`; set `CATALOG_DB_PATH=/srv/anineko/catalog.db` and `SUBTITLE_DATA_DIR=/srv/anineko/subtitles` there. The configured data paths must remain under `/srv/anineko` because that is the only writable path granted by these units.

The ceilings are conservative starting proposals for an 8 GiB Pi, not measured limits. `MemoryMax` includes native buffers and SQLite mappings; validate real peak RSS, stream concurrency, worker provider behavior, temperature, and throttling before enabling. `MemoryHigh` can throttle/pressure a process before the hard limit. The web API is allowed up to 2 GiB and 250% CPU, subtitle work up to 1 GiB and 150% CPU, and Telegram sync up to 768 MiB and 100% CPU. These units do not set a system-wide budget or guarantee capacity if other host workloads consume memory.

Review and install only during an approved maintenance window. Example validation and installation commands (run on the Pi after reviewing paths):

```sh
sudo systemd-analyze verify deploy/systemd/anineko-web.service deploy/systemd/anineko-subtitles-worker.service deploy/systemd/anineko-telegram-sync.service deploy/systemd/anineko-recovery.service deploy/systemd/anineko-recovery.timer
sudo install -o root -g root -m 0644 deploy/systemd/anineko-web.service /etc/systemd/system/anineko-web.service
sudo install -o root -g root -m 0644 deploy/systemd/anineko-subtitles-worker.service /etc/systemd/system/anineko-subtitles-worker.service
sudo install -o root -g root -m 0644 deploy/systemd/anineko-telegram-sync.service /etc/systemd/system/anineko-telegram-sync.service
sudo install -o root -g root -m 0644 deploy/systemd/anineko-recovery.service /etc/systemd/system/anineko-recovery.service
sudo install -o root -g root -m 0644 deploy/systemd/anineko-recovery.timer /etc/systemd/system/anineko-recovery.timer
sudo systemctl daemon-reload
sudo systemctl enable --now anineko-web.service anineko-subtitles-worker.service anineko-telegram-sync.service anineko-recovery.timer
```

Do not run these commands as part of repository build or deployment automation. Verify each service, timer, logs, liveness, persistent DB/assets, and Tunnel behavior before stopping any existing service. Roll back by stopping/disabling only the newly installed units and restoring the prior known-good service definitions. The recovery timer is a local process-restart mechanism; it cannot repair missing secrets, invalid releases, database corruption, or unavailable hardware and will continue recording bounded retry attempts until the underlying cause is fixed.
