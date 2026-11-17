# Capacity planning: Raspberry Pi 5, 8 GB target

The actual Pi was not inspected during this audit. The following are conservative starting caps, not measured capacity claims. Benchmark on the device before raising them.

| Workload | Initial cap | Reason |
|---|---:|---|
| Node API process | 1 process, 1.5 GiB heap ceiling | Preserve RAM for OS, SQLite page cache, and filesystem cache |
| Concurrent stream resolutions | 4 | Provider requests are latency-bound and can fan out |
| Concurrent metadata requests | 4 | Avoid AniList/provider bursts |
| Telegram media streams | 2 dedicated MTProto clients by default (configurable up to 4), 4 queued | Isolate a stalled media RPC to one client slot and bound connection/memory use; overload returns 503 after a short wait |
| Subtitle worker | 1 job | Avoid CPU/RAM competition on the Pi |
| Search/provider queue | 8 active + 8 pending searches; 4 active + 8 pending resolutions; 4 active + 8 pending metadata; 2 active + 4 pending catalog filters per Node process | Reject overload rather than accumulate work; waiters expire after 3 s |

The Node HLS proxy has 8 active requests and 16 waiting slots, a 1 MiB manifest cap, and a 32 MiB media response cap. Worker HLS fetches cap active requests at 8 with the same manifest/segment byte limits. These are code defaults, not Pi benchmark results. The Worker holds its active slot until a media body is consumed or canceled. API gates are process-local (not shared across replicas). Validate the Pi memory budget with the intended stream workload before raising limits.
| In-memory caches | AniList and PlayTube caches are capped and expire; OpenSubtitles batch cache is capped, expires, and evicts failed promises; Telegram media cache caps at 500 | Avoid process-lifetime growth |

Subtitle-index provider host scheduling permits at most 32 live host gates, with at most eight waiters per active slot and a 15-second queue ceiling. Queue saturation returns a retryable service-capacity error instead of accumulating work. AniMa catalogue crawl is limited to 20 pages of 500 posts per crawl.

Subtitle ZIP downloads are limited to 500 entries, 8 MiB expanded per subtitle entry, and 32 MiB total expanded subtitle data. These guard against compressed archives using excessive Pi memory. Archives exceeding the limits fail the provider attempt and allow the worker's retry/provider fallback policy to continue.

Subtitle normalization rejects source text above 8 MiB, more than 20,000 cues per episode, or any single cue above 8,192 characters before translation batching. Normal anime episodes are far below those ceilings; malformed or adversarial files fail the job rather than allocating unbounded cue objects.

Telegram media delivery is bandwidth-bound. The media stream pool allows at most four additional GramJS clients plus the separate metadata and sync clients; default is two media clients and four queued range requests. Prefer direct Telegram/CDN delivery only when the signed media path and browser CORS/range behavior are verified; otherwise the Pi uplink is the ceiling. Avoid transcoding on the Pi. Monitor sustained CPU temperature, throttling, memory pressure, storage free space, and disk latency before increasing concurrency.

Suggested host checks: `vcgencmd measure_temp` and `vcgencmd get_throttled` when available; `free -h`; `vmstat 1`; `iostat -xz 1` (if sysstat is installed); `df -h`; `du -sh /srv/anineko/data`; `systemctl show anineko-web -p MemoryCurrent -p CPUUsageNSec -p TasksCurrent`.

API gate sizes and maximum wait are configurable through `RESOURCE_*` environment variables and clamped to code-defined safe ranges. They are read once at process startup. Middleware applies a global 1200/minute per-client token bucket plus endpoint buckets configured by `REQUEST_RATE_*_PER_MINUTE`. Per-user identity from Pages requires a shared `ANINEKO_RATE_LIMIT_SIGNING_SECRET`, a valid signed forwarded address, and an exact peer match in `REQUEST_RATE_TRUSTED_PROXY_CIDRS`; raw forwarding headers are ignored. These buckets are bounded and process-local, so replicas do not share state and restart resets counters. Proposed systemd templates now set process memory/CPU/task ceilings, but they are not installed and the host audit found current service limits unlimited and memory cgroups unavailable at that time. Verify systemd and cgroup support on the Pi before relying on those ceilings.

Do not install a monitoring stack solely for this service. First export periodic resource snapshots and application counters to structured logs or the existing admin view.
