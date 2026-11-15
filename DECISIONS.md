- npm does not publish `@vidstack/player-ui`; use the published `vidstack` v1 package, which exports the player and UI modules.
- `@vidstack/player@^1.12.13` is also unpublished; the requested version range is provided by `vidstack@^1.12.13`.
- The AniList schema has no description field, so queried English descriptions are stored in build-only `data/descriptions.json` while the requested SQLite schema stays exact.
- Search needs native and romaji names, so `public/search.json` adds those fields alongside the requested display fields.
- `siteUrl` basenames for the three fixture IDs are their numeric IDs; the URLs follow the requested basename rule.
- A hand-written VTT fixture is marked final solely to verify badge and player rendering; replace it with reviewed subtitle content before public use.
Use `solo12345689/api.consumet.org` for local integration because it starts with the current Node runtime and has a matching maintained extensions fork; the original Consumet extension dependency was unavailable during setup.
Keep local `RESOLVER` in ignored `.dev.vars`, with production `RESOLVER` set as a separate Wrangler secret, so localhost configuration cannot leak into deploy config.
Keep the Mux HLS URL only as an explicitly labeled, opt-in playback fixture because current provider metadata endpoints return no HLS source for the tested episode.
