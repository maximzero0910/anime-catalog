# PlayTube subtitle-source discovery

- Discovery used headless Chromium over CDP with Network recording and the site's actual search input (`#search-bar`, name `keyword`).
- Search request observed: `GET https://playtube.tv/search?keyword=<URL-encoded query>`; channel landing page: `https://playtube.tv/@Belion`.
- Search is HTML, not a separate JSON/XHR endpoint. Episode cards expose a `/watch/...` link and title. The channel parser restricts results to Belion and requires a recognized episode marker.
- Observed search terms: `Tokyo Revengers` returned only the title card `Токийски отмъстители (2021)` without an episode; `Токийски отмъстители епизод 1` returned no videos. `Аз ще бъда безсмъртен` returned numbered video titles including Bulgarian-subtitle labels.
- Requests observed returned normal HTML. No published rate-limit response or CAPTCHA was observed; automatic adapter policy is one request per host every 1.5 seconds with the shared real browser User-Agent.
- PlayTube's matched video is hardsub media, not a separate subtitle file. It is tagged and skipped by translation/OCR.
