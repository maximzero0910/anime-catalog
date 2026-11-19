import type { Title } from './db';

export const SITE_ORIGIN = 'https://anineko.eu';

export function canonicalUrl(path: string): string {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return new URL(normalized, SITE_ORIGIN).href;
}

export function absoluteHttpUrl(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export function cleanDescription(value: string | null | undefined): string {
  return (value ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

export function animeDisplayTitle(title: Pick<Title, 'id' | 'title_bg' | 'english' | 'romaji' | 'native'>): string {
  return title.title_bg ?? title.english ?? title.romaji ?? title.native ?? `Anime ${title.id}`;
}

export function animeMetaTitle(title: Title): string {
  const name = animeDisplayTitle(title);
  const details = [title.format, title.year].filter(Boolean).join(' · ');
  return `${name}${details ? ` (${details})` : ''} — Anineko`;
}

export function animeMetaDescription(title: Title, synopsis?: string | null): string {
  const name = animeDisplayTitle(title);
  const summary = cleanDescription(synopsis ?? title.synopsis_bg);
  if (summary) return `${name}: ${summary}`.slice(0, 160);

  const details = [title.format, title.year, ...title.genres.slice(0, 3)].filter(Boolean).join(' · ');
  return (details
    ? `${name} — ${details}. Информация и епизоди в каталога на Anineko.`
    : `${name} — информация и епизоди в каталога на Anineko.`).slice(0, 160);
}

export function xmlEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export function buildSitemapXml(paths: readonly string[]): string {
  const urls = [...new Set(paths.map(canonicalUrl))];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map(url => `  <url><loc>${xmlEscape(url)}</loc></url>`).join('\n')}\n</urlset>\n`;
}
