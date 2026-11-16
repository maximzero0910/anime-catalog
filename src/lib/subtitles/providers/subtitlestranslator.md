# subtitlestranslator.com discovery

- Page: `https://subtitlestranslator.com/en/`.
- Upload request observed: `POST https://subtitlestranslator.com/src/services/upload_file.php`, `multipart/form-data`, field `files[]`, Referer `https://subtitlestranslator.com/en/`, HTTP 200. Fixture size was 171 bytes.
- The browser then posts to `https://subtitlestranslator.com/en/translate.php` with `application/x-www-form-urlencoded`; the form chooses Bulgarian in its language selector. A Cloudflare managed JavaScript check ran before upload; no interactive CAPTCHA was presented.
- The page entered “Translating…” and reported 100%, but did not produce a translated fixture or issue a translation request in the observed 12-second run. The request body did not expose a working translation endpoint. This provider is classified unusable in unattended mode from this evidence and is kept disabled; no guessed endpoint is called.
- Rate limit: not reached. Runtime does not bypass the Cloudflare check.
