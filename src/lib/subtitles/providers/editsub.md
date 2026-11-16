# editsub.com discovery

- Page: `https://editsub.com/translate`.
- The real upload UI accepted the 171-byte SRT in the browser; no file-upload network request was observed. The file is parsed locally.
- Selecting Bulgarian and SRT, then Translate, sent `POST https://editsub.com/api/translate`, `Content-Type: application/json`, `Referer: https://editsub.com/translate`, JSON `{texts:[...],to:"bg"}`. `texts` are UTF-8 bytes XORed with UTF-8 `editsub.` and hex encoded (verified against the shipped page bundle). Response HTTP 200: `{"translatedText":[...]}` with Bulgarian output. A direct request adding `from:"en"` also returned HTTP 200 and Bulgarian, so runtime supplies explicit source language.
- No CAPTCHA, login, or rate limit was encountered on the free Google path. AI mode is a separate paid/credit path and is not used.
- The page request omits a source-language field; runtime adds the verified `from` field accepted by the endpoint.
