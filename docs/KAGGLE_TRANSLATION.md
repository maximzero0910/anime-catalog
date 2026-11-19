# Kaggle GPU subtitle translation

The Anineko Pi owns the queue, source assets, validation, and completed subtitle artifacts. Kaggle is a replaceable GPU worker. The Pi remains available when Kaggle is offline.

## Production endpoints and secrets

Set these two Kaggle Secrets (the values are case-sensitive):

- `ANINEKO_API_URL`: `https://api.anineko.eu`
- `ANINEKO_WORKER_TOKEN`: the worker token already stored in `/etc/anineko-worker.env` on the Pi. Never place the token in notebook source, output, or logs.

The backend accepts authenticated JSON `POST` requests at `/api/worker/claim`, `/api/worker/heartbeat`, `/api/worker/checkpoint`, `/api/worker/complete`, and `/api/worker/fail`. Requests require `Authorization: Bearer <token>` and the notebook identifies itself as `AninekoKaggleWorker/1.0`. A live probe received Cloudflare 403/1010 with Python's default urllib User-Agent, then HTTP 200 with the named worker User-Agent. The public queue summary is `GET /api/translations/status` and does not return credentials.

The worker claims one job at a time. If the persistent queue is empty, a claim performs an idempotent catalog fill, capped by `SUBTITLE_QUEUE_CAP` (default 100), then discovers subtitle candidates before returning a source. English is preferred; Japanese is used when English is unavailable. Existing validated Bulgarian tracks and hardsub entries are skipped. Claiming and discovery do not require manual database inserts. Provider discovery renews its lease while the claim request is running; the notebook also renews the lease every 30 seconds during inference and stops submitting checkpoints if ownership is lost. A discovered native Bulgarian file is stored as a provider artifact and marked complete without GPU translation.

## Restart and recovery behavior

Every inference batch is saved to the Pi's content-addressed subtitle storage through `/api/worker/checkpoint`. The job row keeps only the checkpoint path/hash and cue counts. If Kaggle disconnects, its lease expires; a replacement worker receives the saved partial subtitle and resumes at the next cue. Upload verifies cue count and timestamps before creating a validated artifact. Repeated completion is idempotent. Failed jobs use bounded retry timing and dead-letter after the configured attempt ceiling.

The API's worker token is loaded by systemd from `/etc/anineko-worker.env`. Kaggle does not have access to the Pi's filesystem or database.

## Notebook execution

1. Open `notebooks/anineko_translation_worker.ipynb` in Kaggle.
2. Select a GPU accelerator. One or two GPUs are detected automatically; each receives an independent FP16 `facebook/nllb-200-distilled-600M` model.
3. Confirm the two Kaggle Secrets above are present.
4. Run the notebook's single Python cell. It polls continuously, checkpoints translated batches, adapts batch size after GPU out-of-memory errors, and stops before the Kaggle session limit.
5. Monitor progress at `https://api.anineko.eu/api/translations/status` or the subtitle administration page. A completed artifact is served by the existing Bulgarian subtitle route without a frontend release.

The notebook reports model, detected GPU count, completed episodes/cues, failures, and episode throughput. These are measurements from the current session, not a guaranteed benchmark. Translation quality must be reviewed on the canary episode before scaling the queue.

## AniList priority refresh

`npm run anilist:sync-popularity` requests AniList popularity pages 1 and 2 (50 entries each), matches them against local title metadata, writes rank tiers, and reapplies manual overrides. The Pi systemd timer template is `deploy/systemd/anineko-anilist-sync.timer`; install it only after its runner points to the active immutable release. Tokyo Revengers AniList entry `178083` has a seeded operator priority. Partially translated series receive priority ahead of unranked work; completed episodes remain untouched.

## Local verification

Run:

```sh
npm run subtitles:test
npx tsc --noEmit
npm run build
```

The Kaggle model itself must be run in Kaggle to verify GPU availability, model download, NLLB quality, and end-to-end translation throughput. No local test substitutes for that production canary.
