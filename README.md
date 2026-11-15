# Аниме BG

Static Astro catalog with Bulgarian subtitles and a local Consumet API integration. AniList IDs and titles live in build-time SQLite; `data/provider-map.json` records the explicit AniList-to-provider anime and episode IDs. Nothing queries SQLite after build. The Worker forwards API calls to Consumet and streams HLS or MP4 in flight; it never stores video segments.

## Local setup

Use Node.js 20+, npm, Python 3.11, and ffmpeg. The API is a community-maintained Consumet fork, run separately from this repository:

```sh
cd ..
git clone https://github.com/solo12345689/api.consumet.org.git consumet-api
cd consumet-api
npm install --allow-git=all
PORT=3000 npm start
```

In another terminal, from this project directory:

```sh
cp .dev.vars.example .dev.vars
npx wrangler dev --local --ip 127.0.0.1
```

In a third terminal:

```sh
npm install
npm run dev
```

Open `http://localhost:4321/`. The provider search on the home page calls the local API through Wrangler. It supports search, metadata/episode listing, and a per-episode stream metadata request. `/watch/1/1?test=1` plays Mux's public Big Buck Bunny HLS sample through the Worker as a player-only smoke test; it is not a Consumet result or anime episode. Local `RESOLVER` lives in ignored `.dev.vars`; production configuration is kept separate and must be supplied as a Wrangler secret.

Refresh explicit provider mappings after starting Consumet:

```sh
RESOLVER=http://127.0.0.1:3000 npm run provider:sync
```

The current map uses Anikoto for the three fixture titles. Provider IDs and episode IDs are not inferred from AniList IDs.

## Catalog build

```sh
npm run ingest
npm run build:index
npm run build
```

Ingestion fetches the IDs in `data/fixtures.json`, writes `data/catalog.db`, and stores English synopsis build data. The static build emits title, episode, search and Pagefind files.

## Subtitle workflow

Run in order using the same episode source so cue timings come from that audio:

```sh
python tools/subs.py extract '<episode.m3u8>' /tmp/episode.wav
python tools/subs.py transcribe /tmp/episode.wav /tmp/episode.srt
python tools/subs.py translate /tmp/episode.srt /tmp/episode.bg.srt --glossary data/glossary.json
python tools/subs.py to-vtt /tmp/episode.bg.srt public/subs/<anilist_id>/<episode>.vtt
python tools/subs.py check public/subs/<anilist_id>/<episode>.vtt
```

`translate` reads `OPENAI_API_KEY` or `DEEPL_API_KEY` from the environment. The glossary maps recurring source names to fixed Bulgarian renderings. Transcription uses faster-whisper `large-v3`, Japanese language detection, and VAD filtering. The committed `public/subs/1/1.vtt` is a format fixture, not a completed translation.

## Provider/API note

The API fork starts successfully and Anikoto returns real search results and episode metadata. AnimeWorld and AnimeSaturn also return provider metadata; their tested episode sources were MP4. The Worker streams HLS and byte-range MP4 without persistence and reports DASH/unknown types as unsupported. Provider availability changes independently of this static site. The current Anikoto watch endpoint returns HTTP 500 for the mapped Cowboy Bebop episode, and direct MP4 playback has not been verified. See `HANDOFF.md` for exact results and limitations.

`wrangler.toml` contains production route placeholders only. Before any future production deployment, set `RESOLVER` with `wrangler secret put RESOLVER`; do not copy local `.dev.vars` values into production. Replace `example.com`, contact addresses, and the DMCA agent TODO before deployment.
