import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSitemapXml, canonicalUrl, cleanDescription, xmlEscape } from '../seo';

test('canonical URLs always use the production HTTPS origin', () => {
  assert.equal(canonicalUrl('/anime/a-title/'), 'https://anineko.eu/anime/a-title/');
});

test('description cleaning removes markup and normalizes entities and whitespace', () => {
  assert.equal(cleanDescription('<p>A &amp; B&nbsp; <b>title</b></p>'), 'A & B title');
});

test('sitemap XML escapes data and deduplicates canonical paths', () => {
  const xml = buildSitemapXml(['/anime/a&b/', '/anime/a&b/']);
  assert.equal((xml.match(/<url>/g) ?? []).length, 1);
  assert.match(xml, /https:\/\/anineko\.eu\/anime\/a&amp;b\//);
  assert.equal(xmlEscape("a<&\"'"), 'a&lt;&amp;&quot;&apos;');
});
