# Phase 2 remediation report

Date: 2026-11-16. Branch: `production-hardening`.

## Implemented

- Node `/api/hls` requires HTTPS and configured exact/scoped provider host rules; verifies DNS answers are public; pins the selected address in the Undici connection; validates each redirect; bounds concurrency, wait queue, redirects, transfer size, request timeout and total timeout; cancels upstream work on client disconnect.
- Worker direct `/api/hls`, manifest-generated `/s`, and resolver-generated `/p/...` media fetches enforce the same `HLS_ALLOWED_HOSTS` policy, reject IP literal destinations, manually validate redirects, enforce bounded active transfers and byte/time ceilings, and propagate request cancellation. Media remains streamed with backpressure and Range forwarding.
- Added mocked proxy regression tests for URL validation, redirects, redirect limits, private destination rejection, DNS public/private answer rejection in Node, payload limits, timeouts, client cancellation, saturation, Worker route validation, HLS manifest rewriting, segment streaming and Range handling.
- Dependency remediation upgraded Astro/Node adapter to patched releases and overrode the vulnerable esbuild range. Build exposed missing Astro frontmatter delimiters in two existing admin pages; fixed both.
- Documented Worker DNS pinning limitation and required host configuration.

## Dependency results

`npm audit --omit=dev`: **0 advisories**. Astro 7 is a major upgrade because the patched adapter requires Astro 7.2+ and the advisory set includes fixes only available in Astro 7. Existing page generation/build now succeeds. Pi runtime compatibility still needs verification because the patched Astro release requires Node.js >=22.23.4.

## Provider hostname evidence

Code inspection confirms provider-controlled resolver origins `anikoto.cz`, `9anime.or.at`, `reanime.net`, `allanime.day` / `api.allanime.day`, and `playtube.tv`; PlayTube validates media at `saphiracdn.com` or `playtube.tv`; Anikoto and NineAnime embeds use `megaplay.buzz`. A previously observed Anikoto playback returned `fetch.nexabloom.top` and a segment at a rotating subdomain of `twilightharbor.space`.

This is not yet a complete production host inventory: extracted HLS URLs and CDN domains can change by episode and provider response. Do not add generic CDN suffixes. Capture representative URL hosts from each enabled provider and configure exact hostnames or the narrow provider-owned rotating zone in `HLS_ALLOWED_HOSTS`. The checked-in `.env.example` intentionally includes only the observed Anikoto hosts.

## Implemented but environment-dependent

- Both proxy implementations fail closed if `HLS_ALLOWED_HOSTS` is absent. This protects against an arbitrary destination but playback will not work until the Pi and any Worker deployment receive the verified provider host list.
- Worker host allowlisting and redirect validation are implemented, but connection-time DNS pinning cannot be implemented with the standard Cloudflare Worker `fetch()` API used here. The Worker remains vulnerable to DNS rebinding of a specifically allowlisted domain unless Cloudflare's runtime/network policy blocks the private destination. This behavior has not been independently verified.

## Verification

Run `npm run test:proxy` for mocked proxy regression cases, `npm run build` for the production build, and `npm audit --omit=dev` for production dependency advisories. Pi ARM64/runtime and external E2E services are separate prerequisites and are not implied by these checks.
