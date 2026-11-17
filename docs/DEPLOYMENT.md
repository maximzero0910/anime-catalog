# Production deployment

## Current release (2026-11-17)

The frontend and backend run application commit `65e975270e159d3389c5b3f8b21e19af529c1c14` from branch `production-hardening`; it is pushed to `origin/production-hardening`. The application commit is shared by both tiers. Subsequent documentation-only commits do not change the deployed application.

- Frontend: Cloudflare Pages project `anime-catalog`, domain `anineko.eu`. The project uses manual deployments (Git provider: none); deployment metadata records branch `master`, but no production branch is configured on the project.
- Pages deployment: `be5f2f2c-5fe1-458c-82e3-504ec33b6c49`, status `success`, environment `production`, commit metadata `65e975270e159d3389c5b3f8b21e19af529c1c14`, `commit_dirty=false`, Pages Functions bundle uploaded. Deployment URL: `https://be5f2f2c.anime-catalog-e84.pages.dev`; production alias: `https://anineko.eu`.
- Previous production deployment retained for immediate rollback: `76585599-199c-468a-a082-551c94566a34` (same application commit). Earlier fallback: `9274052f-88c9-4cfe-b59a-64a150a430c4` (commit `9ddf295a`). The Pages project uses manual deployments with no Git provider; Cloudflare reports `master` as its production branch, and the deployment metadata records `master`.
- Pages Function routes `/api/*` to the production secret `ANINEKO_API_ORIGIN`, set to `https://api.anineko.eu`. Cloudflare redacts the secret on readback; the deployed function was verified through live API and playback requests.
- API DNS: proxied CNAME `api.anineko.eu` to tunnel `21a48fed-d0bb-42c0-b978-6e8b13cf72e9.cfargotunnel.com`.
- Tunnel: existing tunnel `anineko-pi-origin`, healthy, ingress `api.anineko.eu` → `http://127.0.0.1:4321`; catch-all remains `http_status:404`. The existing `api-origin.anineko.eu` compatibility DNS and ingress were retained; its health path currently returns 200, so the reported 404 is no longer reproducible.
- Pi: Debian 13 AArch64, Node `v22.23.5`, release at `/srv/anineko/releases/65e975270e159d3389c5b3f8b21e19af529c1c14`.
- Persistent database, subtitle files, Telegram session, and `.env` remain outside the release directory. Services run as the existing `max` account. No Pi application or SSH port is exposed directly.

The earlier public 404 was consistent with the state recorded by the prior read-only audit: `api.anineko.eu` was absent from DNS and the Pages origin binding had no usable target; the deployed Pages response was an HTML 404 rather than the Function's JSON error. The current CNAME, Pages origin binding, Function routing, and backend path are verified below.

## Pi services and resource controls

The following services are active and point to the release directory:

| Service | Runtime | Limits |
| --- | --- | --- |
| `anineko-web.service` | Astro Node server on `127.0.0.1:4321` | 1536 MiB Node heap, 250% CPU, 512 tasks |
| `anineko-subtitles-worker.service` | Persistent subtitle queue worker | 1024 MiB Node heap, 150% CPU, 256 tasks |
| `anineko-subtitles-indexer.service` | Persistent subtitle source indexer; drains queued jobs only | 384 MiB Node heap, 50% CPU, 64 tasks |
| `anineko-telegram-sync.service` | Telegram synchronization worker | 768 MiB Node heap, 100% CPU, 128 tasks |

All four services are active on the new release, retain `Restart=on-failure`, and have a five-start limit over ten minutes. Release-specific systemd drop-ins are in `/etc/systemd/system/<service>.service.d/50-release.conf`. The indexer is started with `--watch --queued-only`; it logged `queued=0` for catalog enumeration and did not enqueue the full catalogue. Provider reactivation did requeue existing durable miss jobs, which the service processes one at a time.

`anineko-recovery.timer` is enabled. Its oneshot only resets/restarts the four allowlisted application units when systemd reports them failed. After this release, a manual run returned `Result=success`, `ExecMainStatus=0`, and left all active units running.

The Pi exposes `cpuset`, `cpu`, `io`, and `pids` cgroup controllers, but not `memory`. Therefore `MemoryMax` is not enforced (`infinity` is reported). `NODE_OPTIONS` limits the JavaScript heap only; native allocations and SQLite mappings are not covered by that cap. Reassess memory limits if the kernel/cgroup configuration later enables the memory controller. Pre-deploy readings were 7.9 GiB RAM, 7.0 GiB available, 44 GiB disk free, and AArch64; the build ran on the Pi itself.

The existing `.env` was preserved and copied with mode 0600 to `/srv/anineko/.deploy-backups/pre-65e9752/units/anineko.env`. Do not print or commit this file. The SQLite database and subtitle assets remain at `/srv/anineko/data/catalog.db` and `/srv/anineko/data/subtitles`.

## Backups and rollback

Before activation, `tools/catalog-backup.ts` created and verified `/srv/anineko/.deploy-backups/pre-65e9752/catalog/anineko-2026-11-17T17-54-12-911Z/`. It contains a 40,554,496-byte SQLite snapshot and all 138 subtitle assets. The backup and live database passed `PRAGMA integrity_check` (`ok`) and `PRAGMA foreign_key_check` (0 violations). The prior `9ddf295a` release remains available. The three previous service drop-ins, recovery script, and `.env` are backed up under `/srv/anineko/.deploy-backups/pre-65e9752/units/`; the environment backup is mode 0600.

To roll the Pi back to the previous `9ddf295a` release, stop and disable the newly added indexer, restore the three saved service drop-ins and prior recovery script, reload systemd, then restart the existing services. This leaves the database, subtitle assets, Telegram session, `.env`, and release directories intact:

```sh
sudo systemctl disable --now anineko-subtitles-indexer.service
sudo install -m 0755 /srv/anineko/.deploy-backups/pre-65e9752/units/anineko-recover-failed /usr/local/libexec/anineko-recover-failed
sudo install -m 0644 /srv/anineko/.deploy-backups/pre-65e9752/units/anineko-web-50-release.conf /etc/systemd/system/anineko-web.service.d/50-release.conf
sudo install -m 0644 /srv/anineko/.deploy-backups/pre-65e9752/units/anineko-subtitles-worker-50-release.conf /etc/systemd/system/anineko-subtitles-worker.service.d/50-release.conf
sudo install -m 0644 /srv/anineko/.deploy-backups/pre-65e9752/units/anineko-telegram-sync-50-release.conf /etc/systemd/system/anineko-telegram-sync.service.d/50-release.conf
sudo systemctl daemon-reload
sudo systemctl restart anineko-web.service anineko-subtitles-worker.service anineko-telegram-sync.service
```

For frontend rollback, roll the Pages project back to `76585599-199c-468a-a082-551c94566a34` in Cloudflare. The Pages origin remains configured as a secret; both frontend releases use the same `/api/*` contract. Do not restore the database for a code rollback.

## Verification recorded for this release

- Clean Pages worktree at the release SHA: `npx astro sync && npm run build` passed. The ARM64 Pi release ran `npm ci`, `npx astro sync`, and `npm run build` successfully. `systemd-analyze verify` passed before activation.
- `npx tsc --noEmit` passed. Broad test sweep: 178 passed, 0 failed. `npm run test:e2e` separately reported 4 failures because resolver/Worker services at `127.0.0.1:3000` and `127.0.0.1:8787` were unavailable, plus 1 opt-in media test skipped; these are not counted as passing.
- Current `npm audit` and `npm audit --omit=dev` report 11 high-severity dependency paths from one `picomatch` advisory (affected through 4.0.7; GitHub currently lists no patched version). npm's suggested forced Astro downgrade is a major-version change and was not applied. `git diff --check` passed. The pre-existing worktree change `data/catalog.db` was not staged or deployed.
- Pages deployment `be5f2f2c-5fe1-458c-82e3-504ec33b6c49` is active in production and records the release SHA with `commit_dirty=false`; `/api/*` is served by its Functions bundle. The production `ANINEKO_API_ORIGIN` variable is a Cloudflare `secret_text` and is redacted on readback; the live Pages-to-API requests verified forwarding.
- Public DNS resolution and TLS verification succeeded. Direct API and Pages-proxied `/api/health/live` and `/api/health/ready` returned HTTP 200 JSON. Unauthenticated subtitle and Telegram admin endpoints returned HTTP 401 JSON.
- `anineko.eu/`, `/anime/154587/`, `/watch/154587/5/`, and `/provider-watch/?provider=telegram&episodeId=32&number=5&title=Frieren...` returned HTTP 200 HTML after deployment `be5f2f2c`. The previous active Pages deployment returned 404 for `/provider-watch/` even though the clean build contained `dist/client/provider-watch/index.html`; re-uploading that exact build directory corrected the missing public route. Aggregate search `Frieren` returned HTTP 200 with Telegram and AniKoto rows; unauthenticated subtitle admin returned HTTP 401 JSON.
- Pages-proxied `/api/stream/154587/5` returned HTTP 200 and selected Telegram MP4 with `hardsub: "bg"`. Chromium opened the deployment URL, clicked play after the media reached `readyState=4`, and advanced for 11.74 seconds (`paused=false`, 1280×720, no media error); the player showed “Български хардсаб · вграден във видеото”. `/api/telegram/media/32` returned HTTP 206 with 1,024 bytes for `Range: bytes=0-1023` after the Pages rollout.
- `/api/subtitles/1/5` returned HTTP 200 `text/vtt`, 53,557 bytes, and a `WEBVTT` header. The hardsub episode `/api/subtitles/154587/5` returns `SKIPPED` with `hardsub: true` and no separate VTT, which avoids OCR/translation; its catalogue label is “Frieren: Beyond Journey's End Mini Anime”, an ambiguous source mapping that remains a metadata limitation.
- Web, translation worker, indexer, Telegram sync, and named Tunnel services are active with zero restarts. Translation worker control is `running` with a fresh heartbeat; no translation jobs were in flight at verification (19 completed, 103 failed, 28 skipped). The indexer reports `mode=queued-only` and is reducing persisted provider-miss work one job at a time: the latest status capture had 669 jobs total (285 completed, 383 queued, 1 running, 0 failed). Provider reactivation explains the queued backlog; the indexer did not enqueue the full catalogue. The recovery oneshot returned `Result=success`, `ExecMainStatus=0`. The live database remained integrity `ok` with zero foreign-key violations.

## Deployment procedure

1. Confirm the branch, commit, clean/dirty working-tree changes, and secret/database exclusions before packaging. Preserve user changes; never copy a checkout's `data/catalog.db` over production.
2. Build in an immutable release directory under `/srv/anineko/releases/<commit-sha>` on ARM64. Run `npm ci`, `npx astro sync`, and `npm run build` against the existing absolute database and subtitle-asset paths.
3. Before activation, create and verify a `catalog:backup`, preserve `/srv/anineko/.env`, and copy the active systemd unit files. Verify SQLite integrity and available disk space.
4. Keep the active root checkout and its existing data intact. Use systemd drop-ins to point services at the immutable release, retaining the original environment file and persistent database/asset paths. Run `systemd-analyze verify` and `systemctl daemon-reload` before restarting.
5. Build from a clean worktree and deploy the Pages Functions bundle to `anime-catalog` with branch `master` and the exact source commit SHA. Preserve the previous successful deployment for rollback.
6. Verify direct Pi health, tunnel-backed API health, the Pages proxy, unauthenticated admin rejection, catalog/search, a real provider response, byte-range video delivery, and subtitle delivery. A successful deploy command alone is not verification.

Docker is not used on this Pi release. Keep the backend bound to loopback and use the existing Cloudflare Tunnel; do not add router port forwards for SSH or the backend.
