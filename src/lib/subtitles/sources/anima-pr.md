# AniMa BG Fansubs discovery

- Discovery used headless Chromium over CDP, typed into the actual catalogue filter (`input#search`, placeholder `Търси по заглавие...`) and recorded Network requests.
- The visible catalogue filter is client-side over embedded `.card[data-title]` entries; typing does not make a network request. Its Blogger search form is `GET /search?q=<query>`, but that route did not return a Tokyo Revengers post.
- Feed crawl endpoint: `GET https://anima-pr.blogspot.com/feeds/posts/default?alt=json&max-results=500&start-index=N`. Observed page sizes: 150 at start-index 1, 70 at 151, empty at 221. Post links use Blogger `rel=alternate` URLs.
- Post page parsing searches for direct `.vtt` / `.srt` links. No direct track means catalog/hardsub metadata only; it is not downloaded or OCR processed.
- No CAPTCHA or rate-limit response was observed. Adapter applies one request per host every 1.5 seconds; feed cache is one week.
- Tokyo Revengers appears on the visible catalogue as `Tokyo Revengers S1-2`, but the crawled feed/search did not contain an episode post or subtitle file, so no episode track can be claimed for AniList 142853 from this source.
