# SubsUnacs discovery and request shape

- Reuses the repository's existing `SubsunacsProvider` implementation from `src/lib/subtitles/index-providers.ts` rather than adding a second parser.
- Request shape: URL-encoded POST to the provider's existing search endpoint with `m=<title season episode>`, language/category fields, and referer `https://subsunacs.net/index.php`; the result parser resolves the subtitle page and download entry.
- Search and fetch use the existing shared HTTP helper, host concurrency cap 1, conditional cache, and browser User-Agent. Adapter-level cadence is one request per host every 1.5 seconds.
- No new endpoint or provider rate-limit behavior is inferred here. Provider-specific response failures remain visible in worker job logs.
