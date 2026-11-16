# Capacity planning: Raspberry Pi 5, 8 GB target

The actual Pi was not inspected during this audit. The following are conservative starting caps, not measured capacity claims. Benchmark on the device before raising them.

| Workload | Initial cap | Reason |
|---|---:|---|
| Node API process | 1 process, 1.5 GiB heap ceiling | Preserve RAM for OS, SQLite page cache, and filesystem cache |
| Concurrent stream resolutions | 4 | Provider requests are latency-bound and can fan out |
| Concurrent metadata requests | 4 | Avoid AniList/provider bursts |
| Telegram media streams | 8 | Streaming still consumes sockets and network bandwidth |
| Subtitle worker | 1 job | Avoid CPU/RAM competition on the Pi |
| Search/provider queue | bounded 32 pending per process | Reject overload rather than accumulate work |

The Node HLS proxy has 8 active requests and 16 waiting slots, a 1 MiB manifest cap, and a 32 MiB media response cap. Worker HLS fetches cap active requests at 8 with the same manifest/segment byte limits. These are code defaults, not Pi benchmark results. The Worker holds its active slot until a media body is consumed or canceled. Validate the Pi memory budget with the intended stream workload before raising limits.
| In-memory caches | bounded entry and TTL policies | Avoid process-lifetime growth |

Telegram media delivery is bandwidth-bound. Prefer direct Telegram/CDN delivery only when the signed media path and browser CORS/range behavior are verified; otherwise the Pi uplink is the ceiling. Avoid transcoding on the Pi. Monitor sustained CPU temperature, throttling, memory pressure, storage free space, and disk latency before increasing concurrency.

Suggested host checks: `vcgencmd measure_temp` and `vcgencmd get_throttled` when available; `free -h`; `vmstat 1`; `iostat -xz 1` (if sysstat is installed); `df -h`; `du -sh /srv/anineko/data`; `systemctl show anineko-web -p MemoryCurrent -p CPUUsageNSec -p TasksCurrent`.

Do not install a monitoring stack solely for this service. First export periodic resource snapshots and application counters to structured logs or the existing admin view.
