# Backup and recovery

The application uses SQLite and file-backed subtitle artifacts. Discover the live database/data paths from the Pi service environment before scheduling backups; never infer them from the checkout.

Use `npm run catalog:backup -- <destination-directory>` or SQLite's online backup API while the database is live. The command writes a timestamped directory using SQLite online backup, copies the configured `SUBTITLE_DATA_DIR` immutable assets, refuses symlinks, checks destination free space before writing, computes SHA-256 hashes, checks SQLite integrity and foreign keys, checks that every subtitle artifact/asset path referenced by the database is in the backup, rejects extra unmanifested files, and verifies the staging snapshot before publishing it atomically. Incomplete staging directories older than 24 hours are reclaimed on the next run. The manifest records the absolute original asset root because some DB rows contain absolute asset paths. Restore assets under that same path before starting services; relocation requires a reviewed DB path-rewrite tool, which is not included. A filesystem copy of a live WAL database without its WAL files is not a valid backup.

`deploy/systemd/anineko-catalog-backup.timer` and `.service` define a daily 03:20 local-time backup. The service stores snapshots under `/srv/anineko/data/backups/catalog`, reserves at least 2 GiB of free space, keeps at least 14 snapshots, and prunes verified-on-creation snapshots older than 30 days. It uses low CPU and I/O priority and has no network access. The runner reads the web unit's `WorkingDirectory` so it follows the configured release and fails closed if the release is missing the backup tool. The timer is a deployment template and has not been installed on the Pi. Before installation, create the destination with owner `max:max`, confirm the current systemd WorkingDirectory points to a release containing `tools/catalog-backup.ts`, install the runner and unit files, run the service once, verify its log and backup, then enable the timer. The backup destination is on the same physical filesystem as the application, so this schedule protects against application and process failures but not USB/storage loss; maintain an encrypted off-device copy before treating disaster recovery as complete.

Proposed installation after review:

```sh
sudo install -d -o max -g max -m 0750 /srv/anineko/data/backups
sudo install -m 0755 deploy/systemd/anineko-catalog-backup-run /usr/local/libexec/anineko-catalog-backup
sudo install -m 0644 deploy/systemd/anineko-catalog-backup.service deploy/systemd/anineko-catalog-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl start anineko-catalog-backup.service
sudo journalctl -u anineko-catalog-backup.service -n 30 --no-pager
sudo systemctl enable --now anineko-catalog-backup.timer
systemctl list-timers anineko-catalog-backup.timer --no-pager
```

Rollback disables the timer and removes only the installed service, timer and runner; it leaves all backups intact. Confirm the journal reports `catalog_backup_verified` before enabling the schedule.

Monthly restore drill: copy the backup to a separate recovery directory and run `npm run catalog:backup -- --verify <recovery-directory>`, then open its `catalog.db` read-only and confirm title/episode/job/artifact counts and a sample subtitle file. The automated tests create temporary SQLite backups, open the snapshots as restored DBs, verify subtitle assets, exercise free-space refusal, stale-staging cleanup, and retention; this does not count as a Pi/off-device restore drill. A previously verified Pi snapshot exists, but the daily timer is not installed and no off-device restore has been verified. Never test restoration over the live database. Before schema changes, create and verify a backup; record the migration version with it.

Recovery order: stop writers, preserve a copy of current database and logs, restore the selected backup and matching asset tree to a new directory, validate integrity and permissions, point the service at it, start the API, then start background workers. Preserve the failed state for diagnosis until recovery is confirmed.
