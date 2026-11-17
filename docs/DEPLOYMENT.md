# Raspberry Pi deployment

## Current production connectivity (verified 2026-11-17)

- Frontend: Cloudflare Pages project `anime-catalog`, production domain `anineko.eu`.
- API: `https://api.anineko.eu`; its proxied DNS record is a CNAME to the existing tunnel UUID's `cfargotunnel.com` hostname.
- Tunnel: `anineko-pi-origin`, remotely managed configuration version 2. Both `api.anineko.eu` and the retained compatibility hostname `api-origin.anineko.eu` route to `http://127.0.0.1:4321`; unmatched hostnames return Tunnel 404.
- Pi service: `anineko-web.service`, active, Node standalone entry at `/srv/anineko/dist/server/entry.mjs`, bound only to `127.0.0.1:4321`. The `cloudflared-anineko.service` connector is active. The backend port is not publicly bound.
- Pages Function: `/api/*` is included in `_routes.json` and forwards to `ANINEKO_API_ORIGIN=https://api.anineko.eu`. The binding is stored as Cloudflare `secret_text`; Cloudflare's read API does not return its value. A successful apex API request confirms the deployed Function used a working origin.
- Latest direct-upload Pages deployment: `b4684595-8c46-4b1d-96f4-714e8dd77a6a`, production, successful, uses Functions. It was uploaded from the Pi's current static asset build and Pages Function source to preserve the live UI and routing behavior.
- Pi API health handlers were absent from the deployed source/build and returned Astro HTML 404. Added `/api/health/live` and `/api/health/ready`, built in an isolated staging directory on the Pi, verified both locally, backed up the prior server bundle at `/srv/anineko/.deploy-backups/server-before-health-20261117`, swapped the server bundle, and restarted `anineko-web.service`. The readiness handler checks the existing catalogue by reading its titles and returns no infrastructure details.
- Public checks after repair: `api.anineko.eu/api/health/live` and `/ready` returned HTTPS 200 JSON; `anineko.eu/api/health/live` and `anime-catalog-e84.pages.dev/api/health/live` returned HTTPS 200 JSON; `anineko.eu/api/subtitles/providers` returned HTTPS 200 JSON; unauthenticated `anineko.eu/api/telegram/admin` returned HTTPS 401 JSON; `anineko.eu/` returned HTTPS 200 HTML. Curl reported TLS verify result 0 and no redirects for these requests.

The initial API 404 had multiple causes: the requested `api.anineko.eu` DNS hostname and Tunnel ingress were absent (only `api-origin.anineko.eu` existed), and the deployed Pi build did not contain the health routes, so direct-origin health requests also returned the site's HTML 404. Repairing only DNS would not have fixed the missing backend route. The existing `api-origin` DNS record and ingress were retained.

These checks verify health, API proxying, TLS, and an authentication rejection; they do not verify video playback, subtitle workflows, rate-limit identity behavior, or worker recovery. The Pi contains the directly installed health route/build, while this checkout has its matching source changes uncommitted. A later backend release should include those source files.

## Deployment procedure

The Pi is Debian 64-bit AArch64 (Raspberry Pi kernel). Its persistent service data currently resides under `/srv/anineko`; the root filesystem had 46 GiB free in the read-only audit. Verify current mount and service details before changing them.

1. Confirm the current 64-bit Debian install, supported Node.js version, `/srv/anineko` storage and mount stability, cooling, and outbound internet.
2. Create a dedicated unprivileged `anineko` account. Keep project code read-only to the service account; place SQLite and subtitle assets under a configurable persistent data directory on the mounted disk.
3. Install production dependencies from the lockfile on ARM64 and build on the target or a matching ARM64 builder. Run the Node standalone server bound to loopback on port 4321. Do not run `astro dev` in production.
4. Review the proposed service units in [`deploy/systemd`](../deploy/systemd/README.md). They bind the API to loopback, restart crashed processes with a bounded restart burst, and set initial cgroup memory/CPU/task ceilings. The ceilings are proposals, not device measurements; check the Pi's systemd features and measured workload before installing.
5. Reuse the remotely managed `anineko-pi-origin` tunnel; its `api.anineko.eu` and compatibility `api-origin.anineko.eu` hostnames already point to loopback port 4321. Keep SSH and admin services private. Verify there is no router port-forward for application or SSH ports.
6. Configure secrets in a root-readable environment file outside the repository, set admin tokens, and keep Telegram credentials server-side.
7. Before future releases, verify `/api/health/live`, `/api/health/ready`, catalog access, a known stream, Telegram byte-range request, subtitle request, admin authorization, and backups. Current public health, provider-status, and unauthorized-admin probes are verified as listed above; stream and subtitle playback smoke tests remain outstanding.

The service templates expect `/opt/anineko/current`, `/etc/anineko/anineko.env`, and persistent `/srv/anineko`; adjust and review those paths for the actual mount layout before installation. The templates are not active and do not change the Pi. Docker Compose is intentionally not supplied: this deployment uses native SQLite and systemd, and introducing a container wrapper before verifying persistent paths and ARM64 package support could obscure data or break the running service.
