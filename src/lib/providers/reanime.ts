import { abs, allMatches, firstMatch, httpGet, type AudioMode, type EpisodeRef, type Provider, type SearchHit, type StreamSource, verifyPlaylist } from './types';

export const BASE = 'https://reanime.net';
const id = 'reanime';
const headers = { referer: `${BASE}/` };

export const reanime: Provider = {
  id,
  weight: 1,
  score: 1,
  async searchByTitle(q: string): Promise<SearchHit[]> {
    const { text } = await httpGet(`${BASE}/search?q=${encodeURIComponent(q)}`, { provider: id, headers });
    const results: SearchHit[] = [];
    for (const match of allMatches(text, /<a\b[^>]*href=["']([^"']*\/anime\/([a-z0-9-]+)[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
      const title = match[3].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if (title) results.push({ id: match[2], title });
    }
    return results;
  },
  async listEpisodes(seriesId: string): Promise<EpisodeRef[]> {
    const { text } = await httpGet(abs(BASE, `/anime/${encodeURIComponent(seriesId)}`), { provider: id, headers });
    const episodes: EpisodeRef[] = [];
    const seen = new Set<string>();
    for (const match of allMatches(text, /\/anime\/[a-z0-9-]+\/(?:ep-)?(\d+)(?:[/?"'#]|$)/gi)) {
      const num = Number(match[1]);
      const epId = match[0].match(/\/anime\/[a-z0-9-]+\/(?:ep-)?\d+/i)?.[0];
      if (epId && !seen.has(epId)) { seen.add(epId); episodes.push({ num, id: abs(BASE, epId) }); }
    }
    return episodes.sort((a, b) => a.num - b.num);
  },
  async resolve(episodeId: string, mode: AudioMode): Promise<StreamSource[]> {
    const episodeUrl = abs(BASE, episodeId);
    const { text } = await httpGet(episodeUrl, { provider: id, headers });
    const iframe = firstMatch(text, [/(?:src|data-src|data-video)="([^"]+)"/i]);
    if (!iframe) return [];
    const embedUrl = abs(episodeUrl, iframe);
    const { text: embed } = await httpGet(embedUrl, { provider: id, referer: episodeUrl });
    let streamUrl = firstMatch(embed, [/sources:\s*\[[^\]]*?"file"\s*:\s*"([^"]+)"/i, /"url"\s*:\s*"([^"]+\.m3u8[^\"]*)"/i, /(https?:\/\/[^"'\s\\]+\.m3u8[^"'\s\\]*)/i, /atob\("([A-Za-z0-9+/=]{20,})"\)/i]);
    if (!streamUrl) return [];
    if (/^atob/i.test(streamUrl)) streamUrl = streamUrl.slice(5, -1);
    // The fourth pattern captures the base64 argument directly.
    if (/^[A-Za-z0-9+/=]{20,}$/.test(streamUrl) && !/^https?:/i.test(streamUrl)) {
      try { streamUrl = atob(streamUrl); } catch { return []; }
      streamUrl = firstMatch(streamUrl, [/sources:\s*\[[^\]]*?"file"\s*:\s*"([^"]+)"/i, /"url"\s*:\s*"([^"]+\.m3u8[^\"]*)"/i, /(https?:\/\/[^"'\s\\]+\.m3u8[^"'\s\\]*)/i]) ?? streamUrl;
    }
    const url = abs(embedUrl, streamUrl.replace(/\\\//g, '/'));
    const sourceHeaders = { referer: new URL(embedUrl).origin + '/' };
    if (!await verifyPlaylist(url, sourceHeaders)) return [];
    const source: StreamSource = { url, quality: 'auto', type: 'hls', headers: sourceHeaders, subtitles: [], audio: mode, provider: id };
    return [source];
  },
  async health(): Promise<boolean> {
    try { const response = await httpGet(BASE, { provider: id, retries: 0 }); return response.status >= 200 && response.status < 400; } catch { return false; }
  },
};

export default reanime;
