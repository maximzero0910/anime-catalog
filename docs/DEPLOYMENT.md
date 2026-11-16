# Raspberry Pi deployment

The Pi's OS, ARM64 status, filesystem, Tunnel, and current service definitions were not verified from this checkout. This is a preparation checklist; do not treat it as a completed deployment.

1. Confirm a 64-bit Raspberry Pi OS install, supported Node.js version, USB/SSD mount stability, cooling, and outbound internet.
2. Create a dedicated unprivileged `anineko` account. Keep project code read-only to the service account; place SQLite and subtitle assets under a configurable persistent data directory on the mounted disk.
3. Install production dependencies from the lockfile on ARM64 and build on the target or a matching ARM64 builder. Run the Node standalone server bound to loopback on a fixed port. Do not run `astro dev` in production.
4. Use systemd with `Restart=on-failure`, `RestartSec=5`, `NoNewPrivileges=true`, `PrivateTmp=true`, `ProtectSystem=strict`, `ProtectHome=true`, `UMask=0077`, explicit writable paths, and conservative `MemoryMax`/`CPUQuota` after observing actual usage.
5. Configure Cloudflare Tunnel to expose only the loopback API port on `api.anineko.eu`; keep SSH and admin services private. Verify there is no router port-forward for application or SSH ports.
6. Configure secrets in a root-readable environment file outside the repository, set admin tokens, and keep Telegram credentials server-side.
7. Verify liveness, catalog access, a known stream, Telegram byte-range request, subtitle request, admin authorization, and backups before DNS/API cutover.

Docker Compose is intentionally not supplied yet: the project uses native SQLite and systemd in the existing deployment, and the Pi deployment dependencies/mount points have not been inspected. Adding a container wrapper before verifying persistent paths and ARM64 package support risks obscuring data or breaking the running service.
