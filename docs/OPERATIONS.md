# Operations

These commands assume the Pi service names previously used in deployment. Confirm them on the target host before relying on them.

Set `HLS_ALLOWED_HOSTS` in the server environment before starting the API. Entries are comma-separated exact hosts; `*.zone.example` matches only subdomains of that specific provider-owned zone, not the apex. The checked-in example covers only observed resolver hosts and is not a complete provider inventory. Add a host only after confirming it is returned by an enabled provider. If the setting is empty or a host is not allowed, playback proxying fails closed (503 for missing configuration; 403 for a destination rejection).

```sh
sudo systemctl status anineko-web anineko-subtitles-worker anineko-telegram-sync
sudo journalctl -u anineko-web -u anineko-subtitles-worker --since '30 minutes ago' --no-pager
sudo systemctl restart anineko-web
sudo systemctl restart anineko-subtitles-worker
free -h; df -h; vmstat 1 5
```

Check the public liveness endpoint and a frontend page separately. Liveness should report only process availability; readiness should verify required local storage access without exposing paths or credentials. During an outage, check Tunnel status, service state, disk space, SQLite integrity, then upstream provider health. Do not restart workers repeatedly when their state indicates a provider cooldown.

Health probes:

- `GET /api/health/live` returns process liveness only.
- `GET /api/health/ready` performs a small local catalog/schema query; a 503 means local storage is unavailable. It intentionally does not require AniList, Telegram, or video providers.
- Authenticated subtitle/Telegram admin responses expose heartbeat age/state. A heartbeat older than 30 seconds is stale; this is detection, not an automatic worker restart. The host service manager must enforce restart policy.

Create and verify a backup to a mounted destination with `npm run catalog:backup -- /mnt/backup/anineko`. Verify a previously created directory with `npm run catalog:backup -- --verify /mnt/backup/anineko/anineko-<timestamp>`. Add `--prune --retain-days 30 --minimum-count 14` only for the dedicated catalog-backup directory; pruning is restricted to recognized Anineko snapshot names and retains at least 14 snapshots. The command uses SQLite's online backup API, checks a configurable free-space reserve, database integrity/foreign keys, and subtitle references, copies assets without following symlinks, and writes SHA-256 checksums. Its manifest records the source asset root; restore assets there because database artifact paths can be absolute. Use a destination outside the database and asset directories, preferably another device. The Pi systemd timer template is in `deploy/systemd`; it remains uninstalled until host-specific review and an explicit deployment step. Restore testing must happen in a new directory using `BACKUP_AND_RECOVERY.md`; never point a live service at an unverified copy.

Subtitle logs/provider HTTP caches are pruned by subtitle workers. Configure `SUBTITLE_LOG_RETENTION_DAYS` and `SUBTITLE_LOG_MAX_ROWS`; validated artifacts, active jobs and dead letters are intentionally not pruned automatically. API concurrency gates have bounded active slots and short bounded wait queues; overload returns a retryable 503.

Telegram GramJS requests use `TELEGRAM_OPERATION_TIMEOUT_MS` (30 seconds by default, clamped to 5–120 seconds). Sync and catalog lookup have separate clients; media streaming uses a bounded pool of dedicated clients so one stalled chunk retires only that slot. Configure `TELEGRAM_MEDIA_CLIENTS` (default 2, maximum 4), `TELEGRAM_MEDIA_MAX_WAITING` (default 4), and `TELEGRAM_MEDIA_WAIT_MS` (default 3000). Saturation returns 503 with `Retry-After`; it does not mark a media reference as broken. The admin page reports active/queued media client counts. On SIGINT/SIGTERM, the sync worker aborts its pending page request, persists its latest checkpoint, releases its SQLite lease, and then exits. A timeout records a failed sync and the worker's bounded exponential backoff applies. Pool behavior is unit-tested, but live GramJS timeout/reconnect and Pi stop behavior remain unverified.

The API middleware applies a global process-local token bucket of 1200 requests/minute per client, plus endpoint buckets: general API 240/min, search 30/min, metadata 60/min, stream resolution 18/min, HLS/segments 900/min, and admin 30/min (initial bursts are capped). Configure `REQUEST_RATE_GLOBAL_PER_MINUTE` and `REQUEST_RATE_*_PER_MINUTE` for measured traffic. For per-user limits behind Pages, set the same random secret of at least 32 bytes in the server-only Pages Function binding `ANINEKO_RATE_LIMIT_SIGNING_SECRET` and the Pi environment. Pages signs its Cloudflare-ingress client IP; the Node middleware accepts the signed value only when the socket peer matches an exact `REQUEST_RATE_TRUSTED_PROXY_CIDRS` CIDR and the signature is no more than 60 seconds old. The proxy strips user-supplied identity headers before forwarding. If signing or peer configuration is absent/invalid, rate limiting safely falls back to the socket peer, so users behind one tunnel share a budget. `X-Forwarded-For` and raw backend `CF-Connecting-IP` are never trusted by the app. Counters are bounded but process-local, so replicas do not share quotas; retain Cloudflare edge protections and the API concurrency gates. This signed hop is necessary because [Cloudflare documents that same-zone Worker subrequests can derive `CF-Connecting-IP` from mutable `x-real-ip`](https://developers.cloudflare.com/fundamentals/reference/http-headers/#cf-connecting-ip-in-worker-subrequests).

On deployment, retain the previous release directory and the matching SQLite backup until smoke checks pass. Roll back the application bundle and restore data only when a migration is known to be backward-incompatible; never overwrite a newer live database with an older copy.
