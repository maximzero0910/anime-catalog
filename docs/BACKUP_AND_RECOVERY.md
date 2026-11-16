# Backup and recovery

The application uses SQLite and file-backed subtitle artifacts. Discover the live database/data paths from the Pi service environment before scheduling backups; never infer them from the checkout.

Use SQLite's online backup API or `sqlite3 .backup` while the database is live. A filesystem copy of a live WAL database without its WAL files is not a valid backup. Back up the database and referenced artifact files as one timestamped set, record checksums, and copy an encrypted second copy off the Pi. Keep retention bounded by disk budget. Exclude logs, caches, and regenerable provider metadata unless needed for a recovery point.

Monthly restore drill: restore to a separate directory, run `PRAGMA integrity_check`, confirm title/episode/job/artifact counts, and verify a sample subtitle file. Never test restoration over the live database. Before schema changes, create and verify a backup; record the migration version with it.

Recovery order: stop writers, preserve a copy of current database and logs, restore the selected backup and matching asset tree to a new directory, validate integrity and permissions, point the service at it, start the API, then start background workers. Preserve the failed state for diagnosis until recovery is confirmed.
