import { createDecipheriv, createHash } from 'node:crypto';
import { abs, allMatches, evaluateKwikPackedPlayer, firstMatch, httpGet, httpPost, qualityFrom, strictDomStub, type AudioMode, type EpisodeRef, type Provider, type SearchHit, type StreamSource, verifyPlaylist } from './types';

export const BASE = 'https://9anime.or.at';
const id = '9anime';
const headers = { referer: `${BASE}/` };

function decryptOpenSsl(value: string, passphrase: string): string | undefined {
  try {
    const encrypted = Buffer.from(value, 'base64');
    let salt = Buffer.alloc(0);
    let ciphertext = encrypted;
    if (encrypted.subarray(0, 8).toString() === 'Salted__') {
      salt = encrypted.subarray(8, 16);
      ciphertext = encrypted.subarray(16);
    }
    const material: Buffer[] = [];
    let previous = Buffer.alloc(0);
    while (Buffer.concat(material).length < 48) {
      previous = createHash('md5').update(Buffer.concat([previous, Buffer.from(passphrase), salt])).digest();
      material.push(previous);
    }
    const keyIv = Buffer.concat(material);
    const decipher = createDecipheriv('aes-256-cbc', keyIv.subarray(0, 32), keyIv.subarray(32, 48));
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8').trim();
  } catch {
    return undefined;
  }
}

export function decryptEmbed(ciphertext: string): string | undefined {
  const candidates = [ciphertext, Buffer.from(ciphertext, 'base64').toString('utf8')];
  for (const candidate of candidates) {
    for (const passphrase of ['9anime', 'nen']) {
      const value = decryptOpenSsl(candidate, passphrase);
      if (value && /^https?:\/\//i.test(value)) return value;
    }
  }
  return undefined;
}

export function serverIds(html: string, mode: AudioMode): string[] {
  let scope = html;
  const markers = [...html.matchAll(/(?:id|class|data-[\w-]+)=["'][^"']*\b(?:sub|dub)\b[^"']*["']/gi)];
  const selected = markers.find(match => new RegExp(`\\b${mode}\\b`, 'i').test(match[0]));
  if (selected?.index !== undefined) {
    const other = markers.find(match => match.index! > selected.index! && !new RegExp(`\\b${mode}\\b`, 'i').test(match[0]));
    scope = html.slice(selected.index, other?.index ?? html.length);
  }
  const ids = new Set<string>();
  for (const [tag] of allMatches(scope, /<[a-z][^>]*>/gi)) {
    if (!/\bclass=["'][^"']*\bserver\b[^"']*["']/i.test(tag)) continue;
    const dataId = tag.match(/\bdata-id=["']([^"']+)["']/i)?.[1];
    if (dataId) ids.add(dataId);
  }
  return [...ids];
}

function decodeHtml(value: string): string {
  return value.replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([\da-f]+);/gi, (_m, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

function cleanText(value: string): string {
  return decodeHtml(value.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function normalizedTokens(value: string): string[] {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/).filter(Boolean);
}

export function relevantSearchHits<T extends SearchHit>(hits: T[], query: string): T[] {
  const wanted = normalizedTokens(query);
  if (!wanted.length) return hits;
  if (wanted.length === 1 && wanted[0]!.length === 1) {
    return hits.filter(hit => normalizedTokens([hit.title, ...(hit.alt ?? [])].join(' ')).some(token => token.startsWith(wanted[0]!)));
  }
  const relevant = hits.filter(hit => {
    const available = normalizedTokens([hit.title, ...(hit.alt ?? [])].join(' '));
    const counts = new Map<string, number>();
    for (const token of available) counts.set(token, (counts.get(token) ?? 0) + 1);
    return wanted.every(token => {
      const count = counts.get(token) ?? 0;
      if (!count) return false;
      counts.set(token, count - 1);
      return true;
    });
  });
  return relevant;
}

export function extractSubtitleTracks(tracks: Array<{ file?: string; label?: string; lang?: string }>, base: string): StreamSource['subtitles'] {
  return tracks.flatMap(track => {
    if (!track.file) return [];
    try {
      const url = new URL(track.file, base);
      if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) return [];
      const extension = url.pathname.split('.').at(-1)?.toLowerCase();
      const format = extension === 'ass' || extension === 'srt' ? extension : 'vtt';
      return [{ lang: track.lang ?? track.label ?? 'Unknown', url: url.href, format }];
    } catch { return []; }
  });
}

function modernServerItems(html: string, mode: AudioMode): Array<{ id: string; embed?: string }> {
  const result: Array<{ id: string; embed?: string }> = [];
  for (const [tag] of allMatches(html, /<[^>]+>/gi)) {
    if (!/\bclass=["'][^"']*\bserver-item\b[^"']*["']/i.test(tag)) continue;
    if (tag.match(/\bdata-type=["']([^"']+)["']/i)?.[1]?.toLowerCase() !== mode) continue;
    const id = tag.match(/\bdata-id=["']([^"']+)["']/i)?.[1];
    if (!id) continue;
    let embed: string | undefined;
    const encoded = tag.match(/\bdata-embed=["']([^"']+)["']/i)?.[1];
    if (encoded) {
      const decoded = Buffer.from(encoded, 'base64').toString('utf8');
      if (/^https?:\/\//i.test(decoded)) embed = decoded;
    }
    result.push({ id, embed });
  }
  return result;
}

function episodeLinks(html: string): EpisodeRef[] {
  const byNumber = new Map<number, string>();
  for (const [tag] of allMatches(html, /<a\b[^>]*>/gi)) {
    const raw = tag.match(/\bhref=["']([^"']+)["']/i)?.[1];
    const number = Number(tag.match(/\bdata-number=["'](\d+)["']/i)?.[1]);
    const dataId = tag.match(/\bdata-id=["']([^"']+)["']/i)?.[1];
    if (raw && dataId && Number.isSafeInteger(number) && number >= 1 && !byNumber.has(number)) {
      byNumber.set(number, `${abs(BASE, raw)}#episode-id=${encodeURIComponent(dataId)}`);
    }
  }
  return [...byNumber].map(([num, episodeId]) => ({ num, id: episodeId })).sort((a, b) => a.num - b.num);
}

function urlsIn(value: unknown): string[] {
  if (typeof value === 'string') return value.match(/https?:[^"'\s<>]+(?:\.m3u8|\.mp4)(?:\?[^"'\s<>]*)?/gi) ?? [];
  if (Array.isArray(value)) return value.flatMap(urlsIn);
  if (value && typeof value === 'object') return Object.values(value).flatMap(urlsIn);
  return [];
}

export function decryptMegaSources(encoded: string): { file: string } | undefined {
  try {
    const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const ciphertext = Buffer.from(normalized + '='.repeat((4 - normalized.length % 4) % 4), 'base64');
    const key = Buffer.alloc(32);
    const iv = Buffer.alloc(16);
    Buffer.from('i?LMTAx0Q6,:}50U').copy(key);
    Buffer.from("W0;27ToaUpl_P%'c").copy(iv);
    const decipher = createDecipheriv('aes-256-cbc', key, iv);
    const payload = JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')) as { file?: unknown };
    return typeof payload.file === 'string' && /^https?:\/\//i.test(payload.file) ? { file: payload.file } : undefined;
  } catch { return undefined; }
}

export async function packedUrls(script: string, referer: string): Promise<string[]> {
  const captured: { setup?: unknown; sources?: unknown } = {};
  const player = () => ({ setup: (config: unknown) => { captured.setup = config; }, on: () => undefined, addButton: () => undefined });
  const document = strictDomStub('document', {
    getElementById: () => ({ innerHTML: '', style: {}, classList: { add: () => undefined, remove: () => undefined } }),
    querySelector: () => null,
  });
  const window = strictDomStub('window', { location: { href: referer, hostname: new URL(referer).hostname } });
  try {
    evaluateKwikPackedPlayer(script, 'undefined', { document, window, jwplayer: player, __kwikResult: captured });
  } catch (error) {
    throw error;
  }
  return urlsIn(captured);
}

async function iframeFromEpisode(html: string, episodeUrl: string): Promise<string | undefined> {
  const iframe = firstMatch(html, [/(?:src|data-src|data-video)=["']([^"']+)["']/i]);
  if (!iframe) return undefined;
  return abs(episodeUrl, iframe);
}

export const nineanime: Provider = {
  id,
  weight: 1.15,
  score: 1,
  async searchByTitle(q: string): Promise<SearchHit[]> {
    const url = `${BASE}/?s=${encodeURIComponent(q)}`;
    const html = (await httpGet(url, { provider: id, headers })).text;
    const hits: SearchHit[] = [];
    const seen = new Set<string>();
    for (const [, block] of allMatches(html, /<h3\b[^>]*class=["'][^"']*\bfilm-name\b[^"']*["'][^>]*>([\s\S]*?)<\/h3>/gi)) {
      const match = block!.match(/<a\b[^>]*href=["']([^"']*\/anime\/([^"'/?#]+)\/?)["'][^>]*>([\s\S]*?)<\/a>/i);
      if (!match) continue;
      const slug = match[2];
      const title = cleanText(match[3]!);
      if (slug && title && !seen.has(slug)) { seen.add(slug); hits.push({ id: abs(BASE, `/anime/${slug}/`), title }); }
    }
    return relevantSearchHits(hits, q);
  },
  async listEpisodes(seriesId: string): Promise<EpisodeRef[]> {
    const seriesUrl = abs(BASE, seriesId);
    const { text } = await httpGet(seriesUrl, { provider: id, headers });
    const seriesDataId = firstMatch(text, [/data-series=["']([^"']+)/i, /class=["'][^"']*\bfilm-poster\b[^"']*["'][^>]*data-id=["']([^"']+)/i]);
    if (!seriesDataId) return [];
    const legacy = await httpGet(`${BASE}/ajax/episode/list/${encodeURIComponent(seriesDataId)}`, { provider: id, referer: seriesUrl });
    const legacyEpisodes = episodeLinks(legacy.text);
    if (legacy.status >= 200 && legacy.status < 300 && legacyEpisodes.length) return legacyEpisodes;
    const active = firstMatch(text, [/data-active=["']([^"']+)/i]) ?? '0';
    const current = await httpGet(`${BASE}/wp-json/9animetv/v1/episodes/${encodeURIComponent(seriesDataId)}?active=${encodeURIComponent(active)}`, { provider: id, referer: seriesUrl });
    try {
      const payload = JSON.parse(current.text) as { pages?: string };
      return episodeLinks(payload.pages ?? '');
    } catch { return []; }
  },
  async resolve(episodeId: string, mode: AudioMode): Promise<StreamSource[]> {
    const marked = episodeId.match(/#episode-id=([^#]+)/);
    const episodeUrl = abs(BASE, episodeId.replace(/#episode-id=.*$/, ''));
    const episodeDataId = marked ? decodeURIComponent(marked[1]!) : undefined;
    const { text: page } = await httpGet(episodeUrl, { provider: id, headers });
    let serverMarkup = page;
    if (episodeDataId) {
      const legacy = await httpGet(`${BASE}/ajax/server/list?eid=${encodeURIComponent(episodeDataId)}`, { provider: id, referer: episodeUrl });
      if (legacy.status >= 200 && legacy.status < 300) serverMarkup = legacy.text;
      else {
        const current = await httpGet(`${BASE}/ajax/episode/servers/?id=${encodeURIComponent(episodeDataId)}`, { provider: id, referer: episodeUrl });
        try { serverMarkup = (JSON.parse(current.text) as { html?: string }).html ?? current.text; } catch { serverMarkup = current.text; }
      }
    }
    const currentItems = modernServerItems(serverMarkup, mode);
    const ids = [...new Set([...serverIds(serverMarkup, mode), ...currentItems.map(item => item.id)])];
    const embedCandidates: string[] = [];
    for (const serverId of ids) {
      try {
        const result = await httpPost(`${BASE}/ajax/server`, new URLSearchParams({ id: serverId }).toString(), {
          provider: id,
          referer: episodeUrl,
          headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', accept: 'application/json, text/javascript, */*; q=0.01', 'x-requested-with': 'XMLHttpRequest' },
        });
        if (result.status === 404) continue;
        const json = JSON.parse(result.text) as { result?: { url?: string } };
        if (json.result?.url) {
          const decrypted = decryptEmbed(json.result.url);
          if (decrypted) embedCandidates.push(decrypted);
        }
      } catch { /* Try other servers, then the page iframe fallback. */ }
    }
    for (const item of currentItems) if (item.embed && !embedCandidates.includes(item.embed)) embedCandidates.push(item.embed);
    if (!embedCandidates.length) {
      const iframe = await iframeFromEpisode(page, episodeUrl);
      if (iframe) embedCandidates.push(iframe);
    }
    const streams: StreamSource[] = [];
    for (const embedUrl of embedCandidates) {
      try {
        const embed = await httpGet(embedUrl, { provider: id, referer: episodeUrl });
        const candidates = urlsIn(embed.text);
        const subtitleTracksByUrl = new Map<string, StreamSource['subtitles']>();
        const mediaId = firstMatch(embed.text, [/id=["']megaplay-player["'][^>]*data-id=["']([^"']+)/i]);
        if (mediaId && new URL(embedUrl).hostname.endsWith('megaplay.buzz')) {
          const apiUrl = `${new URL(embedUrl).origin}/stream/getSources?id=${encodeURIComponent(mediaId)}&platform=OTHER&st=other`;
          const result = await httpGet(apiUrl, { provider: id, referer: embedUrl });
          try {
            const payload = JSON.parse(result.text) as { enc?: string; sources?: unknown; tracks?: Array<{ file?: string; label?: string; lang?: string }> };
            const subtitles = extractSubtitleTracks(payload.tracks ?? [], embedUrl);
            if (payload.enc) {
              const decoded = decryptMegaSources(payload.enc);
              if (decoded) { candidates.push(decoded.file); subtitleTracksByUrl.set(decoded.file, subtitles); }
            }
            candidates.push(...urlsIn(payload.sources));
          } catch { /* Continue with source URLs embedded in the page itself. */ }
        }
        for (const scriptMatch of allMatches(embed.text, /<script\b[^>]*>([\s\S]*?eval\s*\(function[\s\S]*?)<\/script>/gi)) {
          candidates.push(...await packedUrls(scriptMatch[1]!, embedUrl));
        }
        for (const candidate of new Set(candidates)) {
          const url = abs(embedUrl, candidate.replace(/\\\//g, '/'));
          if (!/\.m3u8(?:$|\?)/i.test(url)) continue;
          const sourceHeaders = { referer: new URL(embedUrl).origin + '/' };
          if (!await verifyPlaylist(url, sourceHeaders)) continue;
          streams.push({ url, quality: qualityFrom(url), type: 'hls', headers: sourceHeaders, subtitles: subtitleTracksByUrl.get(candidate) ?? [], audio: mode, provider: id });
        }
      } catch { /* Continue through alternate server entries. */ }
    }
    return streams;
  },
  async health(): Promise<boolean> {
    try { const result = await httpGet(BASE, { provider: id, retries: 0 }); return result.status >= 200 && result.status < 400; } catch { return false; }
  },
};

export default nineanime;
