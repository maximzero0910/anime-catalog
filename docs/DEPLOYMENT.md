# Production deployment

## Current release

Runtime was deployed from commit `4fc61e31b3d779c1c72da290429c20fcd24d1511` on branch `production-hardening` on 2026-11-17.

- Frontend: Cloudflare Pages project `anime-catalog`, production domain `anineko.eu`, production branch `master`.
- Pages deployment: `3e752f7b-e3cb-422f-8f75-2e6f4b697c3b`, status `success`, commit metadata points to the release commit. Preview/deployment URL: `https://3e752f7b.anime-catalog-e84.pages.dev`.
- Previous Pages deployment retained for rollback: `b4684595-8c46-4b1d-96f4-714e8dd77a6a`.
- Pages Function routes `/api/*` to the configured secret `ANINEKO_API_ORIGIN=https://api.anineko.eu`. The binding is stored as a Cloudflare secret; its value is not readable from the API. The public Pages-to-API health response verifies that forwarding works.
- API: `https://api.anineko.eu` → proxied CNAME to the existing `anineko-pi-origin` Cloudflare Tunnel → `http://127.0.0.1:4321` on the Pi. The compatibility hostname `api-origin.anineko.eu` remains configured. The tunnel's unmatched-host fallback is 404. No Pi application port or SSH port is exposed publicly.
- Pi: Debian 64-bit AArch64, Node `v22.23.5`, release at `/srv/anineko/releases/4fc61e31b3d779c1c72da290429c20fcd24d1511`.
- Persistent paths and production `.env` remain under `/srv/anineko`; service processes still run as the existing `max` account. The deployment did not replace the dirty `/srv/anineko` checkout.

## Pi services and resource controls

The following services are active and point to the release directory:

| Service | Runtime | Limits |
| --- | --- | --- |
| `anineko-web.service` | Astro Node server on `127.0.0.1:4321` | 1536 MiB Node heap, 250% CPU, 512 tasks |
| `anineko-subtitles-worker.service` | Persistent subtitle queue worker | 1024 MiB Node heap, 150% CPU, 256 tasks |
| `anineko-telegram-sync.service` | Telegram synchronization worker | 768 MiB Node heap, 100% CPU, 128 tasks |

All three retain `Restart=on-failure`, with a five-start limit over ten minutes. Release-specific systemd drop-ins are in `/etc/systemd/system/<service>.service.d/50-release.conf`. Their pre-deployment unit files are backed up at `/srv/anineko/.deploy-backups/config-before-4fc61e31b3d779c1/`.

The Pi exposes `cpuset`, `cpu`, `io`, and `pids` cgroup controllers, but not `memory`. Therefore `MemoryMax` is not enforced (`infinity` is reported). `NODE_OPTIONS` limits the JavaScript heap only; native allocations and SQLite mappings are not covered by that cap. Reassess memory limits if the kernel/cgroup configuration later enables the memory controller.

The existing `.env` was preserved and copied with mode 0600 to `/srv/anineko/.deploy-backups/config-before-4fc61e31b3d779c1/anineko.env`. Do not print or commit this file. The SQLite database and subtitle assets remain at `/srv/anineko/data/catalog.db` and `/srv/anineko/data/subtitles`.

## Backups and rollback

Before activation, `tools/catalog-backup.ts` created and verified a backup at `/srv/anineko/.deploy-backups/pre-4fc61e31b3d779c1/anineko-2026-11-17T16-29-45-155Z/`. It contains a 40,538,112-byte SQLite snapshot and 138 subtitle assets. The Pi database passed `PRAGMA integrity_check` (`ok`) and `PRAGMA foreign_key_check` (0 violations). The previous server bundle is still under `/srv/anineko/dist`; the previous service unit files and environment file are backed up as above.

To roll the Pi back, remove only the three release drop-ins, reload systemd, and restart the services. This restores their original `/srv/anineko` commands while leaving the database, assets, environment file, and release directory intact:

```sh
sudo rm /etc/systemd/system/anineko-web.service.d/50-release.conf
sudo rm /etc/systemd/system/anineko-subtitles-worker.service.d/50-release.conf
sudo rm /etc/systemd/system/anineko-telegram-sync.service.d/50-release.conf
sudo systemctl daemon-reload
sudo systemctl restart anineko-web.service anineko-subtitles-worker.service anineko-telegram-sync.service
```

For frontend rollback, select the prior successful Pages deployment `b4684595-8c46-4b1d-96f4-714e8dd77a6a` in the Cloudflare Pages dashboard and roll back to it. The `ANINEKO_API_ORIGIN` secret and Tunnel/DNS configuration were not changed during this release.

## Verification recorded for this release

- `npx tsc --noEmit` and the production build passed locally before commit. A clean ARM64 install and build also passed on the Pi after running `npx astro sync`; the build generated the static catalog and Node server output.
- `npm audit` and `npm audit --omit=dev` reported zero advisories at release time.
- Full automated suite: 173 passed, 4 E2E tests failed because the required local services on `127.0.0.1:8787` and `127.0.0.1:3000` were unavailable, and 1 opt-in media test was skipped. Those four are not counted as passing.
- Cloudflare Pages deployment completed successfully and the public production deployment metadata names the release SHA.
- Direct Pi and public `api.anineko.eu` `/api/health/live` and `/api/health/ready` returned 200 JSON. `anineko.eu/api/health/live` also returned 200 JSON through the Pages Function. HTTPS verification succeeded (`curl` TLS result 0).
- `anineko.eu/`, `/anime/154587/`, and `/watch/154587/5/` returned 200 HTML. Aggregate search for `Frieren` returned 200 with results from Telegram, Anikoto, and other available providers; AllAnime's upstream returned 500 but did not fail the aggregate response.
- Unauthenticated `/api/telegram/admin` returned 401 JSON.
- `/api/stream/154587/5` selected Telegram MP4 with Bulgarian hardsub. `/api/telegram/media/32` honored `Range: bytes=0-1023` with 206, 1024 bytes, `video/mp4`, and `accept-ranges: bytes`. `ffprobe` read the public media endpoint and identified H.264 1280×720 video, AAC audio, and a 1470-second duration.
- `/api/subtitles/1/5` returned 200 `text/vtt`, 53,557 bytes, 565 cues, language `bg`, source `provider`, score 1.0. Frieren episode 5 is hardsubbed; its subtitle endpoint correctly reported the hardsub/skip state instead of creating a translated track.
- Chromium played Frieren episode 5 from the production watch page for 11.7 seconds (`readyState=4`, `paused=false`, no media error); the browser source was `anineko.eu`.
- An Anikoto HLS probe for Frieren episode 1 returned a valid manifest, but its first media URI returned `image/jpeg`. That provider-specific HLS result is **not** counted as successful video playback and remains an item to diagnose separately. The verified Telegram episode 5 path is working.

## Deployment procedure

1. Confirm the branch, commit, clean/dirty working-tree changes, and secret/database exclusions before packaging. Preserve user changes; never copy a checkout's `data/catalog.db` over production.
2. Build in an immutable release directory under `/srv/anineko/releases/<commit-sha>` on ARM64. Run `npm ci`, `npx astro sync`, and `npm run build` against the existing absolute database and subtitle-asset paths.
3. Before activation, create and verify a `catalog:backup`, preserve `/srv/anineko/.env`, and copy the active systemd unit files. Verify SQLite integrity and available disk space.
4. Keep the active root checkout and its existing data intact. Use systemd drop-ins to point services at the immutable release, retaining the original environment file and persistent database/asset paths. Run `systemd-analyze verify` and `systemctl daemon-reload` before restarting.
5. Build `functions/[[path]].ts` into the Pages `_worker.js`, verify `_routes.json` includes `/api/*`, then deploy to the existing `anime-catalog` production project and branch. Preserve the prior successful deployment for rollback.
6. Verify direct Pi health, tunnel-backed API health, the Pages proxy, unauthenticated admin rejection, catalog/search, a real provider response, byte-range video delivery, and subtitle delivery. A successful deploy command alone is not verification.

Docker is not used on this Pi release. Keep the backend bound to loopback and use the existing Cloudflare Tunnel; do not add router port forwards for SSH or the backend.
