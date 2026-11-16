# translate-subtitles.com discovery

- Page: `https://translate-subtitles.com/`.
- File input observed: `name=file`, `.srt`; Chromium showed a 171-byte fixture. The browser reads the file locally; no multipart upload carrying the file was observed. It creates/loads `/translation.php?<uuid>` and renders a local download link.
- After choosing target `bg`, the page sends `POST https://translate-pa.googleapis.com/v1/translateHtml`, `Content-Type: application/json+protobuf`, `X-goog-api-key` (public key embedded by Google's widget), `Referer: https://translate-subtitles.com/translation.php?<uuid>`. Request body includes the three fixture cues, source `auto`, target `bg`; response was HTTP 200.
- Rate limit: none observed. CAPTCHA: no interactive CAPTCHA observed.
- Translation is performed by the embedded Google widget in the page. Runtime adapter uses the captured request format with the caller's explicit source language and no browser.
