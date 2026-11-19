import { getTitles } from '../lib/db';
import { buildSitemapXml } from '../lib/seo';

export const prerender = true;

export function GET(): Response {
  const paths = ['/', '/about/', '/privacy/', '/dmca/'];
  const seen = new Set<string>();

  for (const title of getTitles()) {
    const slug = title.slug.trim();
    if (!slug || !/^[\p{L}\p{N}-]+$/u.test(slug) || seen.has(slug)) continue;
    seen.add(slug);
    paths.push(`/anime/${encodeURIComponent(slug)}/`);
  }

  return new Response(buildSitemapXml(paths), {
    headers: {
      'content-type': 'application/xml; charset=utf-8',
      'cache-control': 'public, max-age=3600',
    },
  });
}
