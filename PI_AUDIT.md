# Raspberry Pi infrastructure audit

Read-only SSH audit performed 2026-11-16 against `pi-server` (`max@192.168.1.23`). No package, service, firewall, SSH, storage, or application configuration was changed. Environment values and credentials were not read or printed.

## Findings

### Platform and capacity

- OS: Debian GNU/Linux 13.7 (trixie).
- Kernel: `6.18.50+rpt-rpi-2712`, aarch64.
- CPU: ARM Cortex-A76, 4 cores, 1 thread per core; max reported frequency 2.4 GHz.
- RAM: 7.9 GiB total; 978 MiB used, 2.9 GiB free, 6.9 GiB available at audit time.
- Swap: 2 GiB zram, currently unused.
- Temperature: 53.8 °C; `vcgencmd get_throttled` returned `0x0` at audit time.
- Node.js: v22.23.5; npm 10.9.9. This meets Astro 7's stated Node >=22.23.4 engine requirement, but does not replace a production smoke test.

### Storage

- One USB mass-storage device, Kingston DataTraveler 3.0, 57.7 GB; root partition is ext4 on `/dev/sda2`.
- `/` is mounted `rw,noatime`; 57 GB total, 6.7 GB used, 48 GB available (13%). `/srv/anineko` resides on this same root filesystem.
- `/boot/firmware` is a 512 MB vfat partition with 417 MB available.
- No separate 500 GB SSD or other persistent data disk was visible. The USB flash drive currently holds both OS and application data; this is a durability and capacity risk for subtitle assets and SQLite WAL/database writes.
- `/tmp` is tmpfs, so temporary data uses RAM.

### Network and listeners

- Ethernet `eth0` is up with `192.168.1.23/24`, a global IPv6 address, and a link-local IPv6 address. Default IPv4 route is via `192.168.1.1`. Wi-Fi is down.
- TCP listeners: `127.0.0.1:4321` (Anineko Node server), `127.0.0.1:20241` (cloudflared local endpoint), `0.0.0.0:22` and `[::]:22` (sshd), `0.0.0.0:111` and `[::]:111` (rpcbind).
- UDP listeners include rpcbind on all interfaces, Avahi/mDNS on all interfaces, and cloudflared on a dynamic port. DHCPv6 is bound to the link-local interface.
- An active `anineko-quick-tunnel.service` is described as a temporary Cloudflare Tunnel for the Pi API. The exact tunnel hostname/configuration was not inspected because that may expose credentials. The permanent Cloudflare tunnel unit is disabled.
- Anineko's app listener is loopback-only, which is appropriate for tunnel ingress.

### Services and runtimes

- Active: `anineko-web.service`, `anineko-subtitles-worker.service`, `anineko-telegram-sync.service`, and `anineko-quick-tunnel.service`.
- The three Anineko services run as user `max` and are enabled. Docker, containerd, Podman, Ollama, nginx, and Caddy were not found as installed/running services; Docker and Podman executables are absent.
- The active systemd service properties report `MemoryMax=infinity` and `CPUQuotaPerSecUSec=infinity`; `TasksMax=9621`.
- systemd v257 and cgroup v2 are available. The root cgroup lists `cpuset cpu io pids`, but not `memory`; systemd therefore cannot currently enforce a cgroup memory ceiling. This needs a deliberate boot/cgroup configuration plan before claiming memory isolation.

### Firewall

- `nftables`, `ufw`, and `firewalld` services are inactive. Read-only `nft list ruleset` produced no rules. No iptables executables were available to report separate compatibility rules.
- Because there is a global IPv6 address and sshd/rpcbind bind to all IPv6 interfaces, lack of host firewall rules is a significant exposure risk. Router and upstream IPv6 firewall behavior were not inspected, so actual internet reachability is unknown; no claim is made that these ports are currently reachable from the internet.
- The audit did not inspect or change SSH configuration, keys, router rules, or tunnel credentials.

## Risks

1. **High — host firewall / IPv6:** No local firewall policy was found; sshd and rpcbind listen on wildcard IPv4 and IPv6 sockets. Verify upstream IPv6 filtering and later restrict unnecessary listeners/management access after review.
2. **High — rpcbind:** Port 111 is exposed on every interface over TCP and UDP. Confirm whether NFS/RPC is needed; if not, plan to disable it and verify no dependency before changing it.
3. **High — storage durability:** The service data is on a USB flash drive rather than the proposed SSD. Frequent SQLite and artifact writes can wear the drive; capacity is limited to 48 GB free.
4. **High — resource containment:** Current Anineko units have no CPU or memory ceilings, and the cgroup memory controller is unavailable. The worker and stream resolver can compete with the API under load.
5. **Medium — temporary tunnel:** The quick tunnel is active; its hostname and persistence are not verified here. Confirm it is an intended temporary route and does not expose management endpoints.
6. **Medium — discovery daemons:** Avahi/mDNS listens on all interfaces. Confirm LAN discovery is intended.
7. **Positive control:** The Node API listener is on loopback, and no Docker daemon or database listener was found.

## Proposed deployment plan (no changes made)

1. Review this audit. Before any external rollout, establish IPv4/IPv6 ingress policy and determine whether rpcbind and Avahi are required. Restrict SSH to the trusted management path without breaking the confirmed access route.
2. Provision and mount the external SSD using a stable UUID-based mount. Validate filesystem, ownership, free space, and a recovery copy before moving the SQLite catalog or subtitle assets. Keep the current USB system disk intact until restore and rollback are verified.
3. Configure systemd memory-controller availability through the supported Raspberry Pi boot/cgroup mechanism, reboot only in an approved maintenance window, then verify `memory` appears and that `MemoryMax` is enforced. Until then, use conservative Node heap and worker concurrency settings and treat them as weaker safeguards.
4. Add conservative per-service systemd CPU, memory, task, restart, and sandbox limits after measuring the existing workload. Preserve the web API's loopback binding and keep workers off the public ingress path.
5. Verify Node app configuration without printing secrets; validate `HLS_ALLOWED_HOSTS` against observed provider output and confirm all services use no-store where appropriate.
6. Replace or confirm the temporary tunnel with an explicitly approved named Tunnel configuration targeting only `127.0.0.1:4321`. Do not route SSH, rpcbind, admin management, or worker control ports through it.
7. Add bounded journald retention and scheduled SQLite/artifact backups to the SSD plus an encrypted off-device copy. Perform a restore drill before relying on the deployment.
8. Run a staged smoke test: health/API, provider resolution, one HLS manifest and segment, Telegram byte ranges, subtitle worker queue, admin authorization, service restart recovery, and backup restore. Observe memory, CPU, temperature, and disk I/O before increasing concurrency.

## Not verified

- Router/NAT/IPv6 ingress policy and actual public reachability.
- Firewall filtering beyond the empty nftables ruleset; upstream network controls.
- Tunnel hostname, credential handling, and Cloudflare-side rules.
- Contents of service environment files, secret values, SSH configuration, database integrity, backup existence, and provider host coverage.
- Sustained CPU/GPU/memory/disk workload, SSD availability, ARM64 native module rebuild, and restore behavior.

**Review gate:** This document is an inventory and proposal only. No deployment changes should be made until the host firewall/IPv6 exposure, storage destination, memory-controller requirement, and tunnel ingress are reviewed.
