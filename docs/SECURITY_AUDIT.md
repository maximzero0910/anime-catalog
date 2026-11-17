# Security audit

Audit date: 2026-11-16. Scope: checked-in application and the local development host. The Raspberry Pi and Cloudflare account are not reachable from this checkout, so their live firewall, tunnel, and service state remain unverified.

## Findings

### Remediated in application code: arbitrary upstream proxy (SSRF)

The Node route now requires HTTPS and `HLS_ALLOWED_HOSTS`, rejects hosts outside exact/scoped rules, resolves every destination, rejects a DNS set containing a non-public address, pins the selected public IP through Undici's connector, and validates every redirect. It bounds redirects, active/queued operations, response bytes, request time, and total time. Mocked tests cover these checks. The Worker uses the same exact/scoped host rules, rejects IP literals, manually validates redirect targets, bounds time/bytes/concurrency, and propagates client cancellation.

**Worker limitation:** Cloudflare Workers' standard `fetch()` does not expose a DNS lookup/pinning hook equivalent to Undici's custom connector. The Worker checks configured hostnames and redirect destinations but cannot independently prove the resolved IP at socket connection time. DNS rebinding against a configured provider hostname therefore remains an infrastructure/runtime limitation. No DNS-rebinding protection is claimed for that Worker path. Keep `HLS_ALLOWED_HOSTS` restricted to provider-controlled exact names or narrowly scoped rotating subdomains and do not configure user-controlled domains.

### Critical: vulnerable production dependencies

`npm audit --omit=dev --audit-level=high` reports 6 advisories (1 critical, 4 high, 1 low), including Astro XSS/SSRF advisories and `@astrojs/node` request handling issues. Installed Astro is in the vulnerable range. Upgrade Astro and adapter in a compatibility branch, review breaking changes, then run the build and route/security tests. Do not apply `npm audit fix --force` blindly.

### High: no general rate or concurrency limits

Public search, AniList metadata enrichment, stream resolution, Telegram media delivery, and HLS proxy paths have no shared rate limiter or bounded admission control visible in the route code. An unauthenticated caller can multiply expensive provider/API requests or consume Pi bandwidth. Add endpoint-specific limits and semaphores with explicit overload responses. Behind Tunnel, use a verified proxy identity; ignore arbitrary `X-Forwarded-For` values.

### High: production topology is not verified

The checked-in Astro config uses `output: 'static'` with the Node standalone adapter, while API routes opt into SSR. The project also has a separate Cloudflare Worker config with example.com routes. The local machine is x86_64 with 62 GiB RAM; this audit did not inspect the Pi, its systemd limits, tunnel, firewall, disks, or backups. Do not treat local resource or listener output as Pi evidence.

### Medium: broad static CORS rule

`public/_headers` grants `Access-Control-Allow-Origin: *` on `/subs/*`. Subtitle bodies are intended to be public, but this should be confirmed against catalog licensing and caching policy. Remove the header if cross-origin subtitle loading is not needed.

### Medium: admin fallback depends on loopback host checks

Subtitle and Telegram admin writes require bearer tokens when configured and otherwise permit loopback-only access. This is safer than a public no-token fallback, but should be revalidated behind reverse proxies: host/origin values are request-controlled, and string comparison is not constant time. Production must set high-entropy admin tokens and deny admin routes at the edge in addition to application checks.

### Medium: unbounded/large workloads

The HLS route buffers manifest text, Telegram streams use backpressure, and several metadata caches are process-local Maps without size limits. Search/provider fan-out and subtitle worker concurrency need explicit caps. The subtitle worker can run local inference in code/config despite the recent operational preference for remote services; disable that path for the production profile unless deliberately enabled.

## Existing controls observed

- SQL access uses `better-sqlite3`; checked routes use parameterized statements in storage modules.
- Telegram media response streams byte ranges instead of buffering complete videos.
- Telegram admin mutations and subtitle admin mutations have bearer-token checks.
- API routes generally return generic upstream errors rather than full stack traces.
- `.env` and `.env.*` are ignored by Git, with `.env.example` allowed.
- The static `public/_headers` file does not currently set CSP, HSTS, Referrer-Policy, Permissions-Policy, or nosniff globally.

## Release blockers / remaining validation

1. Verify `HLS_ALLOWED_HOSTS` against actual resolver outputs without broadening to generic hosting/CDN suffixes.
2. Decide whether the Worker HLS route should be disabled or remain protected by the provider-host policy given its DNS-pinning limitation.
3. Verify Pi ARM64, systemd/Tunnel binding, firewall, resource caps, storage, and backups on the actual host.
4. Validate a CSP against real production scripts and provider media origins before enabling it.

Readiness: **NOT READY** until the public proxy exposure and dependency advisories are resolved and Pi deployment controls are verified.

## Superseding dependency status (2026-11-17)

The 2026-11-16 dependency count above is historical. A fresh `npm audit` and `npm audit --omit=dev` on 2026-11-17 report 11 high-severity package-path findings, all cascading from the single `picomatch` GHSA-fc5q-39xc-vjpf advisory (CVE-2026-112366). The lock resolves `picomatch` 4.0.7 and 2.3.2; the advisory currently affects versions through 4.0.7 and lists no patched version. The affected paths include Astro, `@astrojs/node`, Vite, `tinyglobby`, `fdir`, `unstorage`, and `anymatch`. npm's proposed force fix downgrades Astro to 5.3.0; that major-version change was not applied because it would roll back the deployed Astro 7 migration and does not establish a patched `picomatch` version. This finding remains open; deployment verification must not be described as a clean dependency audit or READY security posture.

Primary evidence: [GitHub advisory GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf), which lists affected versions through 4.0.7 and no patched version as of this audit.

The clean production build completed, and a string scan of its generated `dist/server` output found no `picomatch` or `analyzeRepeatedExtglob` code. The Pi launches this generated server entry rather than the Astro CLI. This reduces the apparent request-time exposure but does not clear the audit finding: vulnerable packages remain in the install/build tree, and the upstream fix is still unavailable.
