# systemd operations

The repository includes example full service units and a failed-service recovery timer. Inspect the actual host paths, service account, cgroup controllers, mount layout, and database location before installing any unit. The full service templates are not drop-in replacements for an existing deployment.

## Raspberry Pi deployment

The current Pi uses `/srv/anineko`, service account `max`, and immutable releases under `/srv/anineko/releases/<commit>`. It does not use `/opt/anineko/current` or `/etc/anineko/anineko.env`. Existing environment and persistent data remain at `/srv/anineko/.env` and `/srv/anineko/data`. Release-specific resource settings are installed as `50-release.conf` drop-ins; see [deployment documentation](../../docs/DEPLOYMENT.md).

The Pi supports CPU and task cgroup controls but its cgroup v2 controller list omits `memory`. Do not set `MemoryHigh` or `MemoryMax` there and claim enforcement. Node heap ceilings are useful but do not bound native memory or file mappings.

## Failed-service recovery timer

`anineko-recover-failed` only checks these fixed names: `anineko-web.service`, `anineko-subtitles-worker.service`, and `anineko-telegram-sync.service`. It resets and starts a unit only after systemd reports that allowlisted unit in `failed` state. Never pass user-controlled unit names to the script. The timer runs at boot after five minutes and at most every ten minutes thereafter, so it provides a bounded recovery attempt after a normal systemd restart burst is exhausted.

After reviewing the paths and running `systemd-analyze verify`, install the small recovery mechanism independently of the full service templates:

```sh
sudo install -o root -g root -m 0755 deploy/systemd/anineko-recover-failed /usr/local/libexec/anineko-recover-failed
sudo install -o root -g root -m 0644 deploy/systemd/anineko-recovery.service /etc/systemd/system/anineko-recovery.service
sudo install -o root -g root -m 0644 deploy/systemd/anineko-recovery.timer /etc/systemd/system/anineko-recovery.timer
sudo systemd-analyze verify /etc/systemd/system/anineko-recovery.service /etc/systemd/system/anineko-recovery.timer
sudo systemctl daemon-reload
sudo systemctl enable --now anineko-recovery.timer
```

Verify with `systemctl is-active anineko-recovery.timer` and `systemctl list-timers anineko-recovery.timer`. To undo only this mechanism, run `sudo systemctl disable --now anineko-recovery.timer`, then remove its service/timer files and `/usr/local/libexec/anineko-recover-failed`, followed by `sudo systemctl daemon-reload`.

The timer can restart a failed process after systemd's burst limit; it cannot fix invalid configuration, missing secrets, database corruption, disk exhaustion, or unavailable hardware. Keep the script allowlist narrow and review its journal logs after a recovery.
