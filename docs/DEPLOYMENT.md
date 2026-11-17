# Production deployment

## Current release (2026-11-17)

The frontend and backend run the same verified application commit, `9ddf295a6bf6efe44431aeb05cb10ac1099cd501`, from branch `production-hardening`. That commit is pushed to `origin/production-hardening`.

- Frontend: Cloudflare Pages project `anime-catalog`, production branch `master`, domain `anineko.eu`.
- Pages deployment: `9274052f-88c9-4cfe-b59a-64a150a430c4`, status `success`, commit metadata `9ddf295a6bf6efe44431aeb05cb10ac1099cd501`. Deployment URL: `https://9274052f.anime-catalog-e84.pages.dev`; production alias: `https://anineko.eu`.
- Previous successful Pages deployment retained for rollback: `3e752f7b-e3cb-422f-8f75-2e6f4b697c3b`.
- Pages Function routes `/api/*` to the production secret `ANINEKO_API_ORIGIN`, set to `https://api.anineko.eu`. Cloudflare redacts the secret on readback; the deployed function was verified through live API and playback requests.
- API DNS: proxied CNAME `api.anineko.eu` to tunnel `21a48fed-d0bb-42c0-b978-6e8b13cf72e9.cfargotunnel.com`.
- Tunnel: existing tunnel `anineko-pi-origin`, healthy, ingress `api.anineko.eu` → `http://127.0.0.1:4321`; catch-all remains `http_status:404`. The existing `api-origin.anineko.eu` compatibility DNS and ingress were retained; its health path currently returns 200, so the reported 404 is no longer reproducible.
- Pi: Debian 13 AArch64, Node `v22.23.5`, release at `/srv/anineko/releases/9ddf295a6bf6efe44431aeb05cb10ac1099cd501`.
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

The services retain `Restart=on-failure`, with a five-start limit over ten minutes. Release-specific systemd drop-ins are in `/etc/systemd/system/<service>.service.d/50-release.conf`. The indexer is started with `--watch --queued-only`; a restart does not enqueue the full catalogue. Its catalog crawl remains an explicit operator action.

`anineko-recovery.timer` is enabled. Its oneshot only resets/restarts the four allowlisted application units when systemd reports them failed; manual execution on the previous release returned exit status 0 and left active units untouched.

The Pi exposes `cpuset`, `cpu`, `io`, and `pids` cgroup controllers, but not `memory`. Therefore `MemoryMax` is not enforced (`infinity` is reported). `NODE_OPTIONS` limits the JavaScript heap only; native allocations and SQLite mappings are not covered by that cap. Reassess memory limits if the kernel/cgroup configuration later enables the memory controller. Pre-deploy readings were 7.9 GiB RAM, 7.0 GiB available, 44 GiB disk free, and AArch64; the build ran on the Pi itself.

The existing `.env` was preserved and copied with mode 0600 to `/srv/anineko/.deploy-backups/pre-9ddf295/units/anineko.env`. Do not print or commit this file. The SQLite database and subtitle assets remain at `/srv/anineko/data/catalog.db` and `/srv/anineko/data/subtitles`.

## Backups and rollback

Before activation, `tools/catalog-backup.ts` created and verified `/srv/anineko/.deploy-backups/pre-9ddf295/anineko-2026-11-17T17-06-11-520Z/`. It contains a 40,554,496-byte SQLite snapshot and all 138 subtitle assets. The backup and current database passed `PRAGMA integrity_check` (`ok`) and `PRAGMA foreign_key_check` (0 violations). The prior `33fe683` release remains available. The three previous systemd drop-ins and `.env` are backed up under `/srv/anineko/.deploy-backups/pre-9ddf295/units/`; the environment backup is mode 0600.

To roll the Pi back to the previous `33fe683` release, restore the three saved drop-ins, reload systemd, and restart the services. This leaves the database, subtitle assets, Telegram session, `.env`, and release directories intact:

```sh
sudo install -m 0644 /srv/anineko/.deploy-backups/pre-9ddf295/units/anineko-web-50-release.conf /etc/systemd/system/anineko-web.service.d/50-release.conf
sudo install -m 0644 /srv/anineko/.deploy-backups/pre-9ddf295/units/anineko-subtitles-worker-50-release.conf /etc/systemd/system/anineko-subtitles-worker.service.d/50-release.conf
sudo install -m 0644 /srv/anineko/.deploy-backups/pre-9ddf295/units/anineko-telegram-sync-50-release.conf /etc/systemd/system/anineko-telegram-sync.service.d/50-release.conf
sudo systemctl daemon-reload
sudo systemctl restart anineko-web.service anineko-subtitles-worker.service anineko-telegram-sync.service
```

For frontend rollback, roll the Pages project back to `3e752f7b-e3cb-422f-8f75-2e6f4b697c3b` in Cloudflare. The Pages origin remains `https://api.anineko.eu`; both frontend releases use the same `/api/*` contract. Do not restore the database for a code rollback.

## Verification recorded for this release

- Clean worktree at the release SHA: `npx astro sync && npm run build` passed and generated the static catalog and Functions inputs. A bare `npm run build` in the empty worktree first failed because Astro middleware types had not been synchronized; the clean-build sequence then passed.
- ARM64 Pi release: `npm ci`, `npx astro sync`, and `npm run build` completed successfully on the Pi. `systemd-analyze verify` passed before service activation.
- Broad local test sweep: 178 passed, 0 failed. `npm run test:e2e` separately reported 4 failures because local resolver/Worker services at `127.0.0.1:3000` and `127.0.0.1:8787` were unavailable, plus 1 opt-in media test skipped. These E2E failures are not counted as passing; the production browser path was tested separately.
- Current `npm audit` and `npm audit --omit=dev` report 11 high-severity dependency paths from one `picomatch` advisory (affected through 4.0.7; GitHub currently lists no patched version). npm's suggested forced Astro downgrade is a major-version change and was not applied. `git diff --check` passed. The pre-existing worktree change `data/catalog.db` was not staged or deployed.
- Pages deployment `9274052f-88c9-4cfe-b59a-64a150a430c4` completed and reports production, alias `anineko.eu`, commit `9ddf295a6bf6efe44431aeb05cb10ac1099cd501`, and `uses_functions=true`. Public `/api/*` health requests returned dynamic no-store JSON through the Pages Function.
- Public DNS resolution and TLS verification succeeded. Direct API and Pages-proxied `/api/health/live` and `/api/health/ready` returned HTTP 200 JSON. Unauthenticated subtitle and Telegram admin endpoints returned HTTP 401 JSON.
- `anineko.eu/`, `/anime/154587/`, and `/watch/154587/5/` returned HTTP 200 HTML. Chromium search entered `frieren` through the UI, made provider-catalog requests returning HTTP 200, and displayed three cards from Telegram and AniKoto. AllAnime returned upstream HTTP 500; the aggregate search still returned results with a partial-provider notice.
- Pages-proxied `/api/stream/154587/5` returned HTTP 200 and selected Telegram MP4 with `hardsub: bg`. Chromium played the episode unmuted for 11.7 seconds (`readyState=4`, `paused=false`, 1280×720, no media error). `ffprobe` identified H.264 video and AAC audio. `/api/telegram/media/32` honored `Range: bytes=0-1023` with HTTP 206, 1,024 bytes, `video/mp4`, and `Accept-Ranges: bytes`.
- `/api/subtitles/1/5` returned HTTP 200 `text/vtt`, 53,557 bytes, a `WEBVTT` header, 565 cue timestamps, language `bg`, and source `provider`.
- Pi web, subtitle worker, Telegram sync, and recovery timer are active. Authenticated worker resume returned HTTP 200 and control state `running`; worker heartbeats were fresh. Starting the recovery oneshot returned `Result=success`, `ExecMainStatus=0`. The live database remained integrity `ok` with zero foreign-key violations after restart.

## Deployment procedure

1. Confirm the branch, commit, clean/dirty working-tree changes, and secret/database exclusions before packaging. Preserve user changes; never copy a checkout's `data/catalog.db` over production.
2. Build in an immutable release directory under `/srv/anineko/releases/<commit-sha>` on ARM64. Run `npm ci`, `npx astro sync`, and `npm run build` against the existing absolute database and subtitle-asset paths.
3. Before activation, create and verify a `catalog:backup`, preserve `/srv/anineko/.env`, and copy the active systemd unit files. Verify SQLite integrity and available disk space.
4. Keep the active root checkout and its existing data intact. Use systemd drop-ins to point services at the immutable release, retaining the original environment file and persistent database/asset paths. Run `systemd-analyze verify` and `systemctl daemon-reload` before restarting.
5. Build from a clean worktree and deploy the Pages Functions bundle to `anime-catalog` with branch `master` and the exact source commit SHA. Preserve the previous successful deployment for rollback.
6. Verify direct Pi health, tunnel-backed API health, the Pages proxy, unauthenticated admin rejection, catalog/search, a real provider response, byte-range video delivery, and subtitle delivery. A successful deploy command alone is not verification.

Docker is not used on this Pi release. Keep the backend bound to loopback and use the existing Cloudflare Tunnel; do not add router port forwards for SSH or the backend.
