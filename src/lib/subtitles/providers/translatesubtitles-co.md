# TranslateSubtitles.co discovery

- Page: `https://translatesubtitles.co/`.
- Upload request observed in Chromium: `POST https://translatesubtitles.co/upload.php`, `multipart/form-data`, HTTP 200. Form has no named input; the loaded Dropzone library's configured default is `file`, and the page does not set `uploadMultiple`. Headers observed: `X-Requested-With: XMLHttpRequest`, `Accept: application/json`, `Referer: https://translatesubtitles.co/`, browser User-Agent.
- The response navigates to `/translatesub.php?srt=sample-en.srt`; target control is the Bulgarian option (`value=bg`).
- Clicking Translate sends `POST https://translate-pa.googleapis.com/v1/translateHtml`, `Content-Type: application/json+protobuf`, `X-goog-api-key` (public key embedded by Google's widget), and `Referer: https://translatesubtitles.co/`. Captured body contains the cue text list and `auto`, `bg`; response was HTTP 200. Direct request with explicit `en` also returned Bulgarian cue strings, HTTP 200.
- Rate limit: none observed in this one-file probe. CAPTCHA: no interactive CAPTCHA observed.
- Translation uses Google's embedded page widget, not an independent TranslateSubtitles server API. Runtime adapter uses the observed widget request shape and explicit source language; it does not automate a browser.
