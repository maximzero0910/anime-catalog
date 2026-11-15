# Playback Handoff

## Provider adapter stage

- Added `src/lib/providers/types.ts`, `index.ts`, `reanime.ts`, and `allanime.ts` for provider contracts, shared HTTP/playlist helpers, registry fallback, and the two adapters.
- Added `src/lib/providers/tests/reanime.test.ts` and `allanime.test.ts` for live search, episode listing, and episode 1 stream checks.
- The provider adapters are not yet wired into search or metadata routes.
- Deviation: `src/lib/consumet.ts` exposes only `getSourceKind` and no HTTP, extraction, or user-agent helpers; the adapter utilities therefore live in the new provider types module. AllAnime's test verifies HLS sources because `verifyPlaylist` requires an HLS playlist body.
- Validation deviation: `npx tsx --test src/lib/providers/tests/*.test.ts` exited before running tests because `tsx` could not create its IPC pipe (`listen EPERM`, `/tmp/tsx-1000/14.pipe`).

## Diagnostic result

- The local API fork is `solo12345689/api.consumet.org` at `2e255327c42929b87224bd76cefe6d57d60398dd` (2026-08-12). Its lockfile resolves `@consumet/extensions` 1.8.9 from that fork's `consumet.ts` repository at `1f3ce07cf0d42e765f5166de2358bac87b922b45`.
- Official [`@consumet/extensions`](https://www.npmjs.com/package/@consumet/extensions) currently publishes 1.8.8 (2026-01-20). Its package archive contains AnimeSaturn but no Anikoto or AnimeWorld adapter. The [official release history](https://github.com/consumet/consumet.ts/releases) has no Anikoto adapter change. There is no official Anikoto implementation to upgrade to, so this is not fixed by a version bump.
- The upstream release history includes an AnimeSaturn scraper fix (v1.6.0), but it provides no authorization grant for third-party video. Community packs such as [Anisurge](https://github.com/Anisurge/extensions) use a separate app-specific/scraper API and likewise do not establish rights or provide a drop-in Consumet adapter; they were not integrated.
- In the fork's Anikoto adapter, source extraction accepts `sources.file`, `sources.url`, `source`, `url`, or `file`; it does not handle `enc`. The live resolver response had `tracks`, `t`, `intro`, `outro`, `server`, `image`, and `enc`, with no `sources`. The fork therefore reaches its explicit `Stream URL not found` error. The adapter itself was added/modified in the fork; this is a provider response format change unsupported by that adapter.
- Anikoto Cowboy Bebop ep 1 uses the valid mapping `cowboy-bebop-kb7hu$episode$1`; direct resolver search returns 4 results, info returns 26 episodes, and episode extraction finds ep 1.
- Its direct watch endpoint returns HTTP 500. The episode page and exact episode ID are valid; the source parser fails after the embed JSON changed. The resolver returns `enc` but no `sources`, while the installed extension expects `sources`/`file`/`url`. This is a provider/extension compatibility failure, not an Astro/Worker URL or episode mapping failure. No decryptor or synthetic stream was added. Captured resolver exception:

  ```text
  Error: Stream URL not found
      at AniKoto.fetchEpisodeSources (/tmp/anime-catalog-consumet-active/node_modules/@consumet/extensions/src/providers/anime/anikoto.ts:1016:11)
      at processTicksAndRejections (node:internal/process/task_queues:104:5)
  ```
- AnimeWorld and AnimeSaturn search and metadata work (Cowboy Bebop results, 26 episodes). Their resolver returned MP4 source metadata in the earlier probe. Media access and real episode playback remain unverified because those sources were not confirmed as authorized.
- ReAnime search and metadata work (26 episodes); its watch resolution returned HTTP 500 in the earlier probe. Gogoanime search responds successfully but has no Cowboy Bebop results. Miruro search works, while info currently returns HTTP 500 because all mirrors returned 403.

| Provider | `SEARCH_WORKING` | `METADATA_WORKING` | `EPISODES_WORKING` | `SOURCE_WORKING` | `PLAYBACK_VERIFIED` |
|---|---|---|---|---|---|
| Anikoto | yes | yes | yes (26) | no (`Stream URL not found`) | no |
| AnimeWorld | yes | yes | yes (26) | yes (MP4 metadata) | no, unverified |
| AnimeSaturn | yes | yes | yes (26) | yes (MP4 metadata) | no, unverified |
| ReAnime | yes | yes | yes (26) | no (HTTP 500) | no |
| Gogoanime | request works, 0 matches | unavailable | unavailable | unavailable | no, unverified |
| Miruro | yes | no (mirror 403) | no | unavailable | no, unverified |

## Playback and diagnostics changes

- Worker logs provider and explicit capability fields, endpoint, status, error-body excerpts, detected source format, and required header names. It never logs header values or media URLs. Client errors remain sanitized. Playback verification is not performed with a headless browser.
- Worker forwards resolver-provided headers for HLS manifests and MP4, and preserves MP4 range responses. DASH and unknown formats stay explicitly unsupported.
- Added `tools/e2e.test.ts` and `npm run test:e2e` for provider search, metadata/episodes, static title/watch pages, and Anikoto source failure. The opt-in provider media check is skipped unless the test source is explicitly marked authorized. The Chromium playback smoke test was removed.
- The former headless fixture playback smoke test has been removed. The MDN CC0 MP4 and Mux HLS URLs remain fixtures, not provider episodes or current playback verification.
- No authorized AnimeWorld or AnimeSaturn episode source was supplied or established, so their returned third-party media URLs were not requested. Community scraping adapters found during research are not evidence of content rights or authorization and were not integrated.
- Real provider playback is verified for the three current catalog titles through mapped Anikoto HLS, the local `/api/hls` proxy, and the site player. Generic ReAnime and AllAnime live search/source checks remain unavailable as noted above.

## Run locally

Start the local Consumet fork on port 3000, then run:

```sh
npx wrangler dev --local --ip 127.0.0.1
npm run dev -- --host 127.0.0.1
npm run test:e2e
```

The authorized-provider media test requires an approved test source and explicit values:

```sh
AUTHORIZED_MEDIA_TEST=1 AUTHORIZED_PROVIDER=<provider> AUTHORIZED_EPISODE_ID=<episode-id> npm run test:e2e
```

Before any deployment, replace `example.com`, contact addresses, and the DMCA agent TODO. `RESOLVER` is a placeholder; configure it with `wrangler secret put RESOLVER`. Production has not been deployed.

## Browserless provider transport

- Provider HTTP uses `undici` by default. Requests to AnimePahe/Kwik use `impit`, and requests receiving HTTP 403 from undici retry with `impit` using the same Fetch-style call shape.
- Miruro pipe evaluation and Kwik packed player evaluation use `node:vm` with explicit minimal `document` and `window` stubs; unexpected DOM access throws to keep extraction failures visible. No Playwright, Chromium, or other headless browser is used in extraction or deployment.
- The player resolves and plays provider media through `/api/hls`; the Worker rewrites HLS manifests and segment URLs for hls.js. Provider iframes are hidden behind an explicit toggle and offered only when resolution returns no source.

iter 1: `curl -si --max-time 3 http://localhost:4321/api/stream/1/1` returned no response and `ss -ltnp` returned `Operation not permitted` -> probe showed no local Astro process; checking route and provider configuration.
iter 2: route inspection found no `/api/stream` handler or provider allowlist -> add an SSR stream endpoint and explicit `9anime.or.at` registration.
iter 3: `curl -sS -I --max-time 8 https://9anime.or.at/` returned `curl: (6) Could not resolve host` -> remote fetch confirmed the mirror homepage is live; shell-side provider verification remains blocked by sandbox DNS/network policy.
iter 4: `node --import tsx -e "import('./src/lib/providers/nineanime.ts')..."` printed `{"id":"9anime","weight":1.15}` -> adapter module loads; source resolution remains untested until the API route exists and shell networking is available.
iter 5: direct `GET` call to the new route printed `400 {"error":"invalid-episode"}` for an invalid ID -> route guard works; provider resolution is now exposed at `/api/stream/:anilistId/:ep` and falls through providers on empty results.
iter 6: direct `GET` call to `/api/hls` without a target printed `400 missing u` -> new SSR proxy validates inputs and rewrites manifest children; real upstream access still cannot run in this sandbox.
iter 7: `node --import tsx -e "import('./src/lib/db.ts')...getTitleById(1)"` returned catalog metadata for Cowboy Bebop (`id:1`, 26 episodes) -> AniList ID lookup is usable by the stream route; live resolution is still blocked by shell DNS/socket isolation.
iter 8: direct `GET /api/stream/1/1` returned 502 after network errors for ReAnime/AllAnime while 9anime was mislabeled empty -> 9anime now surfaces transport errors instead of swallowing them and recognizes order-independent `.server[data-id]` attributes.
iter 9: `npm run build` first failed with `NoAdapterInstalled`; after adding Astro Node adapter 9.5.5, prerender failed opening `data/catalog.db` from the bundle -> API SSR is enabled with static output preserved; DB path resolution is being corrected for bundled runtime.
iter 10: `npm run build` completed with exit code 0; generated server entry contains `src/pages/api/hls.ts` and `src/pages/api/stream/[anilistId]/[ep].ts` while static pages prerender -> route/build structure is in place, but actual server access and upstream media are still unverified.
iter 11: `npx tsx --test src/lib/providers/tests/nineanime.test.ts` failed before test startup with IPC `listen EPERM`; equivalent inline Node assertions passed for separate sub/dub IDs, VM-captured Kwik HLS URL, and AES-CBC `nen` decryption -> resolver mechanics pass offline, live provider bytes remain unverified.
iter 12: environment check printed `CODEX_SANDBOX_NETWORK_DISABLED=1`, `Seccomp: 2`, and no Astro/Vite/Wrangler process -> no permitted listener or port-forward tool is available here; server, provider media, segment, and browser-playback artifacts remain uncollected.
iter 1 (resumed): `curl -si --max-time 60 http://localhost:4321/api/stream/1/1` returned 502 with 9anime `episode not found`, ReAnime `empty search`, and AllAnime HTTP 500 -> switched validation to the user’s AniList 21/20 fixtures and continued with 9anime until a decrypted embed was reached.
iter 2 (resumed): `curl -sS -D /tmp/reanime.headers -o /tmp/reanime.body 'https://reanime.net/search?q=One%20Piece'; cat headers; wc -c; cat body` returned HTTP/2 404, nginx header, 146-byte `404 Not Found` HTML -> confirmed current ReAnime search path is dead; left its URL untouched pending a valid route.
iter 3 (resumed): `curl -sS 'https://9anime.or.at/?s=One+Piece'` returned a 200 search page whose first `h3.film-name a` title is One Piece: Heroines and subsequent exact hit is One Piece -> changed 9anime search to parse only `h3.film-name a` and use `/?s=`.
iter 4 (resumed): `curl ... /anime/one-piece/` showed `data-series="12"`; GET `/wp-json/9animetv/v1/episodes/12?active=0` returned JSON with `data-number`/`data-id` items (first listed episode 54) -> added current WordPress episode-list fallback while retaining requested legacy endpoint.
iter 5 (resumed): `curl -sS ... /ajax/episode/servers/?id=959` returned a 200 JSON server list with distinct `data-type="sub"` and base64 `data-embed`; POST `/ajax/server` returned 404 -> resolver now uses the current server-list endpoint and its mode-filtered embed as compatibility fallback.
iter 6 (resumed): `curl ... /stream/getSources?id=36491&platform=OTHER&st=other` returned `enc`; Node AES-256-CBC decode produced `https://fetch.nexabloom.top/anime/.../master.m3u8`, and the provider call returned that verified URL for One Piece ep54 sub -> added browserless MegaPlay source decryption and real HLS extraction.

## Featured catalog playback and search

- The current catalog contains Cowboy Bebop (AniList 1), Attack on Titan (16498), and Frieren: Beyond Journey’s End (154587). `data/provider-map.json` already has exact Anikoto episode IDs for all three. Added `src/lib/providers/anikoto.ts`, registered it in `src/lib/providers/index.ts`, reused the MegaPlay AES source decoder in `src/lib/providers/nineanime.ts`, and made the stream route prefer explicit mapped provider episodes. Sub/dub server groups remain separate.
- Live `GET /api/stream/{1,16498,154587}/1` returned verified HLS from Anikoto. For each title the local `/api/hls` master and child manifests returned 200 with `#EXTM3U`, and its first proxied segment returned 200 with nonzero bytes. Visible Chromium playback on the matching catalog pages advanced over 10 seconds for all three (Cowboy Bebop 14.41s, Attack on Titan 10.16s, Frieren 15.00s; readyState 4, no video error).
- Runtime correction: the first One Piece check used the Cowboy Bebop catalog shell and displayed a mismatched title. Rechecked One Piece on a temporary correctly labeled Player route (AniList 21, ep54), observed 11.91s playback, then removed the temporary route.
- Search failure root cause: Astro’s `/api/anime` Vite proxy targets Wrangler on `127.0.0.1:8787`; that Worker was not running, so Astro returned 500 before the request reached Consumet on port 3000. Started Wrangler with `npx wrangler dev --local --ip 127.0.0.1 --port 8787`. `curl -i http://127.0.0.1:4321/api/anime/anikoto/Cowboy%20Bebop` then returned 200 and four JSON results; visible browser search returned `4 реални резултата · anikoto` and Cowboy Bebop, its movie, Session XX, and Ein’s Summer Vacation.
- Verification: `npx tsc --noEmit` passed. `npx tsx --test src/lib/providers/tests/*.test.ts` still reports live ReAnime search empty and AllAnime HTTP 500; the configured catalog stream route uses the verified Anikoto mappings for all catalog titles.
- Changed files: `src/lib/providers/anikoto.ts`, `src/lib/providers/index.ts`, `src/lib/providers/nineanime.ts`, `src/pages/api/stream/[anilistId]/[ep].ts`, and `HANDOFF.md`. No Astro configuration changes remain from this work; the temporary browser smoke route was removed.

iter 7: valid HLS manifests contained either PNG ads or MPEG-TS fragments mislabeled as JPEG -> validate first segment signatures, skip the PNG source, and accept TS sync bytes; `curl` returned a provider m3u8, `/api/hls` returned 200 and `#EXTM3U`, the proxied segment returned 200/159800 bytes, and browser playback advanced to 14.91s.
iter 8: search requests for the default Anikoto provider passed through Wrangler to an absent Consumet service on port 3000 and returned 502 -> route Anikoto search and episode lookup through the in-app provider adapter; both direct API requests now return 200 without Wrangler or Consumet.
