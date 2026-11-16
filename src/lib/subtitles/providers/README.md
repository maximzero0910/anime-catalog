# Subtitle translation providers

`SUBTITLE_PROVIDERS` configures the online adapters in preference order. The worker uses online providers only; local inference is not part of the translation or fallback path.

Default order, based on single-fixture response times: `syedgakbar,translatesubtitles-co,translate-subtitles-com,editsub,subtitlestranslator`.

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

`subtitlestranslator.com` remains registered but disabled because its real UI probe reached 100% without returning translated text. `translatesubtitles.co`, `translate-subtitles.com`, and the SyedGakbar tool all use Google's embedded widget, so they are separate page adapters rather than independent translation engines. `editsub.com` uses its own observed HTTP endpoint.
