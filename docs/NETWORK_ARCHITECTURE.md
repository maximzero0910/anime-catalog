# Network architecture and exposure plan

## Current intended flow

```text
Browser -> Cloudflare Pages (anineko.eu)
Browser -> API hostname (intended api.anineko.eu) -> Cloudflare Tunnel -> Pi Node/Astro API
Pi -> AniList, Telegram, subtitle sites, and video provider origins
Browser -> Cloudflare Pages static assets and subtitle files
```

The production API hostname and Tunnel were not verified from this checkout. `wrangler.toml` configures a different Worker (`anime-cdn`) with `example.com` placeholder routes. Do not deploy it as the Anineko API without replacing those routes and reviewing its purpose.

## Exposure policy

- Public: Pages frontend, explicitly needed `/api/*` routes, and public health/readiness response.
- Private: Pi SSH, SQLite files, worker controls, admin dashboards, local inference, and any future database/cache service.
- Tunnel ingress should target only the API listener bound to loopback or a private interface. Do not add SSH or database ingress.
- Firewall should allow outbound HTTPS and established Tunnel traffic, plus SSH only from a trusted management network. No router port-forwarding is required for the API when Tunnel is used.

## API origin configuration

Use a single configured public API base URL (`https://api.anineko.eu`) in the frontend build. Production browser requests must use HTTPS. Configure CORS to allow only `https://anineko.eu` and the deliberate Pages preview origin if previews are used. Never reflect arbitrary `Origin` values. Requests containing admin credentials or user-specific data must return `Cache-Control: no-store`.

## Cache policy

- Static fingerprinted assets: long-lived immutable caching.
- Public catalog JSON: short TTL with stale-while-revalidate after confirming it contains no private operational state.
- subtitle files: cache only after confirming redistribution and attribution permissions; use bounded TTL.
- stream resolution, Telegram media, admin, health details, and errors: `no-store` unless a specific public cache design is tested.
- Never cache API keys, session data, Telegram file references, stream authorization headers, or admin responses.

## Verification before enabling Tunnel

1. Verify the Pi API binds to `127.0.0.1` or a private interface.
2. Verify Tunnel hostname `api.anineko.eu` targets that exact port and does not expose SSH.
3. Confirm origin certificates/HTTPS, CORS, health endpoint, and Cloudflare cache bypass rules.
4. Confirm direct access from outside the LAN to Pi ports fails.
5. Confirm Pages works when the Pi is offline and presents a useful API-unavailable state.
