# Subtitle translation providers

`SUBTITLE_PROVIDERS` configures the completed online adapters in preference order. Unknown values, including stale `local` settings, are discarded; an empty supported list falls back to all four completed providers.

Default order, based on single-fixture response times: `syedgakbar,translatesubtitles-co,translate-subtitles-com,editsub`.

| Setting | Default | Purpose |
|---|---:|---|
| `SUBTITLE_PROVIDER_TIMEOUT_MS` | 60000 | Per-attempt timeout |
| `SUBTITLE_PROVIDER_JOB_BUDGET_MS` | 300000 | Maximum time spent across the online provider chain |
| `SUBTITLE_MAX_CONCURRENT` | 2 | Concurrent worker jobs; online calls remain capped by the global provider limit |
| `SUBTITLE_PROVIDER_MAX_BATCH_TOKENS` | 2400 | Estimated token ceiling per request |
| `SUBTITLE_PROVIDER_GLOBAL_CONCURRENCY` | 2 | Global concurrent remote requests |
| `SUBTITLE_PROVIDER_REQUESTS_PER_WINDOW` | 1 | Per-provider token bucket capacity |
| `SUBTITLE_PROVIDER_WINDOW_MS` | 4000 | Per-provider token bucket window |
| `SUBTITLE_GOOGLE_WIDGET_API_KEY` | public widget key | Override for the public Google widget key used by three adapters |

Only those four adapters are registered. `subtitlestranslator.com` was removed after its real UI probe stalled at 100% without returning translated text. `translatesubtitles.co`, `translate-subtitles.com`, and the SyedGakbar tool all use Google's embedded widget, so they are separate page adapters rather than independent translation engines. `editsub.com` uses its own observed HTTP endpoint.
