import { abs, allMatches, firstMatch, httpGet, qualityFrom, type AudioMode, type EpisodeRef, type Provider, type SearchHit, type StreamSource, verifyPlayablePlaylist } from './types';
import { decryptMegaSources } from './nineanime';

export const BASE = 'https://anikoto.cz';
const id = 'anikoto';
const rootReferer = `${BASE}/`;
const ajaxHeaders = { accept: 'application/json, text/javascript, */*; q=0.01', 'x-requested-with': 'XMLHttpRequest' };

function htmlText(value: string): string {
  return value.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#0*39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
}

function episodeMarkup(response: string): string {
  try {
    const value = JSON.parse(response) as { result?: unknown; html?: unknown };
    return typeof value.result === 'string' ? value.result : typeof value.html === 'string' ? value.html : '';
  } catch { return ''; }
}

function mappedModeServers(html: string, mode: AudioMode): Array<{ linkId: string; serverId: string }> {
  const starts = [...html.matchAll(/<div\b(?=[^>]*\bclass=["'][^"']*\btype\b[^"']*["'])(?=[^>]*\bdata-type=["'](?:sub|dub)["'])[^>]*>/gi)];
  const result: Array<{ linkId: string; serverId: string }> = [];
  for (let index = 0; index < starts.length; index++) {
    const match = starts[index]!;
    const tag = match[0];
    if (tag.match(/\bdata-type=["']([^"']+)/i)?.[1]?.toLowerCase() !== mode) continue;
    const end = starts[index + 1]?.index ?? html.length;
    const group = html.slice(match.index! + tag.length, end);
    for (const [li] of allMatches(group, /<li\b[^>]*>/gi)) {
      const linkId = li.match(/\bdata-link-id=["']([^"']+)/i)?.[1];
      const serverId = li.match(/\bdata-sv-id=["']([^"']+)/i)?.[1];
      if (linkId && serverId) result.push({ linkId, serverId });
    }
  }
  return result;
}

function extensionFormat(url: string): 'vtt' | 'ass' | 'srt' {
  const extension = new URL(url).pathname.split('.').pop()?.toLowerCase();
  return extension === 'ass' || extension === 'srt' ? extension : 'vtt';
}

export const anikoto: Provider = {
  id,
  weight: 1.25,
  score: 1,
  async searchByTitle(q: string): Promise<SearchHit[]> {
    const result = await httpGet(`${BASE}/search?keyword=${encodeURIComponent(q)}`, { provider: id, referer: rootReferer });
    const hits: SearchHit[] = [];
    const seen = new Set<string>();
    for (const [, attributes, content] of allMatches(result.text, /<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
      const attrs = attributes!;
      const classes = attrs.match(/\bclass=["']([^"']+)["']/i)?.[1] ?? '';
      if (!/(?:^|\s)(?:name|desi-head-title)(?:\s|$)/i.test(classes) && !/\bdata-jp=/i.test(attrs)) continue;
      const href = attrs.match(/\bhref=["']([^"']*\/watch\/[^"']+)/i)?.[1];
      const slug = href?.match(/\/watch\/([^/?#]+)/)?.[1];
      if (!href || !slug || seen.has(slug)) continue;
      const name = htmlText(content!);
      if (!name) continue;
      seen.add(slug);
      const alt = firstMatch(attrs, [/\bdata-jp=["']([^"']+)/i]);
      hits.push({ id: slug, title: name, ...(alt && alt !== name ? { alt: [alt] } : {}) });
    }
    return hits;
  },
  async listEpisodes(seriesId: string): Promise<EpisodeRef[]> {
    const slug = seriesId.replace(/^.*\/watch\//, '').replace(/\/$/, '');
    const seriesUrl = `${BASE}/watch/${encodeURIComponent(slug)}`;
    const series = await httpGet(seriesUrl, { provider: id, referer: rootReferer });
    const main = firstMatch(series.text, [/id=["']watch-main["'][^>]*data-id=["'](\d+)/i, /data-id=["'](\d+)["'][^>]*id=["']watch-main["']/i]);
    if (!main) return [];
    const response = await httpGet(`${BASE}/ajax/episode/list/${main}`, { provider: id, referer: seriesUrl, headers: ajaxHeaders });
    const html = episodeMarkup(response.text);
    const episodes = new Map<number, EpisodeRef>();
    for (const [tag] of allMatches(html, /<a\b[^>]*>/gi)) {
      const number = Number(tag.match(/\bdata-num=["'](\d+)/i)?.[1]);
      if (Number.isSafeInteger(number) && number > 0 && !episodes.has(number)) episodes.set(number, { num: number, id: `${slug}$episode$${number}` });
    }
    return [...episodes.values()].sort((a, b) => a.num - b.num);
  },
  async resolve(episodeId: string, mode: AudioMode): Promise<StreamSource[]> {
    const [slug, rawNumber] = episodeId.split('$episode$');
    if (!slug || !rawNumber) return [];
    const number = Number(rawNumber);
    if (!Number.isSafeInteger(number) || number <= 0) return [];
    const seriesUrl = `${BASE}/watch/${encodeURIComponent(slug)}`;
    const episodeUrl = `${seriesUrl}/ep-${number}`;
    const series = await httpGet(seriesUrl, { provider: id, referer: rootReferer });
    const animeDataId = firstMatch(series.text, [/id=["']watch-main["'][^>]*data-id=["'](\d+)/i, /data-id=["'](\d+)["'][^>]*id=["']watch-main["']/i]);
    if (!animeDataId) return [];
    const episodeResponse = await httpGet(`${BASE}/ajax/episode/list/${animeDataId}`, { provider: id, referer: episodeUrl, headers: ajaxHeaders });
    const episodeHtml = episodeMarkup(episodeResponse.text);
    const episodeTag = allMatches(episodeHtml, /<a\b[^>]*>/gi).map(([tag]) => tag!).find(tag => Number(tag.match(/\bdata-num=["'](\d+)/i)?.[1]) === number);
    const episodeDataIds = episodeTag?.match(/\bdata-ids=["']([^"']+)/i)?.[1] ?? episodeTag?.match(/\bdata-id=["']([^"']+)/i)?.[1];
    if (!episodeDataIds) return [];
    const serverResponse = await httpGet(`${BASE}/ajax/server/list?servers=${encodeURIComponent(episodeDataIds)}`, { provider: id, referer: episodeUrl, headers: ajaxHeaders });
    const serverHtml = episodeMarkup(serverResponse.text) || serverResponse.text;
    const sources: StreamSource[] = [];
    for (const server of mappedModeServers(serverHtml, mode)) {
      try {
        const response = await httpGet(`${BASE}/ajax/server?get=${encodeURIComponent(server.linkId)}&sv=${encodeURIComponent(server.serverId)}`, { provider: id, referer: episodeUrl, headers: ajaxHeaders });
        const payload = JSON.parse(response.text) as { result?: { url?: string } };
        const embedUrl = payload.result?.url;
        if (!embedUrl) continue;
        const embed = await httpGet(embedUrl, { provider: id, referer: episodeUrl, headers: { origin: BASE } });
        const mediaId = firstMatch(embed.text, [/id=["']megaplay-player["'][^>]*data-id=["'](\d+)/i]);
        if (!mediaId || !new URL(embedUrl).hostname.endsWith('megaplay.buzz')) continue;
        const embedUrlObject = new URL(embedUrl);
        const query = new URLSearchParams({ id: mediaId, platform: 'OTHER', st: 'other' });
        const serverType = embedUrlObject.searchParams.get('s');
        if (serverType) query.set('s', serverType);
        const sourceResponse = await httpGet(`${embedUrlObject.origin}/stream/getSources?${query}`, {
          provider: id,
          referer: embedUrl,
          headers: { origin: embedUrlObject.origin, ...ajaxHeaders },
        });
        const sourcePayload = JSON.parse(sourceResponse.text) as {
          enc?: string;
          tracks?: Array<{ file?: string; label?: string; lang?: string }>;
        };
        if (!sourcePayload.enc) continue;
        const decoded = decryptMegaSources(sourcePayload.enc);
        if (!decoded || !await verifyPlayablePlaylist(decoded.file, { referer: `${embedUrlObject.origin}/` })) continue;
        const subtitles = (sourcePayload.tracks ?? []).flatMap(track => {
          if (!track.file || !/^https?:\/\//i.test(track.file)) return [];
          return [{ lang: track.lang ?? track.label ?? 'English', url: track.file, format: extensionFormat(track.file) }];
        });
        sources.push({ url: decoded.file, type: 'hls', quality: qualityFrom(decoded.file), headers: { referer: `${embedUrlObject.origin}/` }, subtitles, audio: mode, provider: id });
      } catch { /* Continue through the selected audio mode's remaining servers. */ }
    }
    return sources;
  },
  async health(): Promise<boolean> {
    try { const response = await httpGet(BASE, { provider: id, retries: 0 }); return response.status >= 200 && response.status < 400; } catch { return false; }
  },
};

export default anikoto;
