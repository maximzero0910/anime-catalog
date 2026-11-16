# syedgakbar.com/projects/dst discovery

- Page: `https://www.syedgakbar.com/projects/dst`.
- Upload request observed: `POST https://www.syedgakbar.com/projects/subtitles-translate/file-upload`, `multipart/form-data`, HTTP 200. Dropzone default field is `file` (the loaded page configuration does not override `paramName`); the page accepts `.srt,.sub,.sbv,.vtt,.ass,.zip`. Headers include the page Referer and browser User-Agent.
- Google (Free) is the selected translator. Selecting Bulgarian in the actual `.goog-te-combo` and clicking Translate produced all three Bulgarian fixture cues.
- Translation request: `POST https://translate-pa.googleapis.com/v1/translateHtml`, `Content-Type: application/json+protobuf`, public widget `X-goog-api-key`, `Referer: https://www.syedgakbar.com/`; body contains the cue text list, source `auto`, target `bg`; response HTTP 200.
- Cloudflare Turnstile scripts/widget are present in the page. No interaction was required on the observed Google (Free) path; the tested translation completed without a CAPTCHA prompt. Rate limit: none observed.
- Runtime uses the observed HTTP widget request, not browser automation. Paid engines are not selected or called.
