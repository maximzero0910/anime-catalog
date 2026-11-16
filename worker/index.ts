const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36';
import { parseProviderHostRules, providerHostAllowed } from '../src/lib/provider-host-policy';
const MAX_HLS_ACTIVE = 8;
const MAX_MANIFEST_BYTES = 1_048_576;
const MAX_SEGMENT_BYTES = 32 * 1_048_576;
let activeHls = 0;

function allowedHost(host: string, rules: string[]): boolean {
  const value = host.toLowerCase().replace(/\.$/, '');
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(value) || value.includes(':')) return false;
  return providerHostAllowed(value, rules);
}

async function fetchAllowed(target: URL, ref: string, range: string | null, rules: string[], clientSignal: AbortSignal, method: 'GET' | 'HEAD' = 'GET'): Promise<Response> {
  if (activeHls >= MAX_HLS_ACTIVE) return new Response('proxy overloaded', { status: 503 });
  activeHls++;
  let transferred = false;
  const signal = AbortSignal.any([clientSignal, AbortSignal.timeout(25_000)]);
  try {
    let current = target;
    for (let hop = 0; hop <= 3; hop++) {
      if (current.protocol !== 'https:' || current.username || current.password || !allowedHost(current.hostname, rules)) return new Response('upstream host is not allowed', { status: 403 });
      const headers = new Headers({ 'User-Agent': UA, Accept: '*/*' });
      if (ref) headers.set('Referer', ref);
      if (range && /^bytes=\d*-\d*(,\d*-\d*)*$/.test(range)) headers.set('Range', range);
      const response = await fetch(current, { method, headers, redirect: 'manual', signal });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('Location');
        if (!location || hop === 3) return new Response('redirect limit exceeded', { status: 502 });
        try { current = new URL(location, current); } catch { return new Response('invalid redirect URL', { status: 502 }); }
        continue;
      }
      const type = response.headers.get('Content-Type') ?? '';
      const manifest = type.toLowerCase().includes('mpegurl') || current.pathname.toLowerCase().endsWith('.m3u8');
      if (method === 'HEAD') return new Response(null, { status: response.status, headers: response.headers });
      const cap = manifest ? MAX_MANIFEST_BYTES : MAX_SEGMENT_BYTES;
      const length = Number(response.headers.get('Content-Length'));
      if (Number.isFinite(length) && length > cap) return new Response('upstream response too large', { status: 413 });
      if (manifest) {
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength > cap) return new Response('upstream response too large', { status: 413 });
        return new Response(bytes, { status: response.status, headers: response.headers });
      }
      if (!response.body) return response;
      let size = 0;
      const reader = response.body.getReader();
      let released = false;
      const release = () => { if (!released) { released = true; activeHls--; } };
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const next = await reader.read();
            if (next.done) { release(); controller.close(); return; }
            size += next.value.byteLength;
            if (size > cap) { release(); await reader.cancel(); controller.error(new Error('upstream response too large')); return; }
            controller.enqueue(next.value);
          } catch (error) { release(); controller.error(error); }
        },
        async cancel(reason) { release(); await reader.cancel(reason); },
      }, { highWaterMark: 1 });
      transferred = true;
      return new Response(body, { status: response.status, headers: response.headers });
    }
    return new Response('redirect limit exceeded', { status: 502 });
  } catch (error) {
    return new Response(signal.aborted ? 'upstream timeout or client cancellation' : 'upstream fetch failed', { status: signal.aborted ? 504 : 502 });
  } finally { if (!transferred) activeHls--; }
}

function cors(response: Response, contentType?: string): Response {
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', '*');
  if (contentType) headers.set('Content-Type', contentType);
  return new Response(response.body, { status: response.status, headers });
}

function rewriteManifest(text: string, base: URL, ref: string): string {
  const proxy = (url: string) => `/s?u=${encodeURIComponent(new URL(url, base).href)}&r=${encodeURIComponent(ref)}`;
  return text.split('\n').map(line => {
    if (!line || line.startsWith('#')) {
      return line.replace(/URI="([^"]+)"/g, (_match, uri: string) => `URI="${proxy(uri)}"`);
    }
    return proxy(line.trim());
  }).join('\n');
}

function rewriteApiManifest(text: string, base: URL, ref: string): string {
  const proxy = (url: string) => `/api/hls?u=${encodeURIComponent(new URL(url, base).href)}&r=${encodeURIComponent(ref)}`;
  return text.split('\n').map(line => {
    if (!line || line.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_match, uri: string) => `URI="${proxy(uri)}"`);
    return proxy(line.trim());
  }).join('\n');
}

function mediaKind(source: { url?: string; isM3U8?: boolean; type?: string }): string {
  const url = (source.url ?? '').toLowerCase().split('?')[0];
  const type = source.type?.toLowerCase() ?? '';
  if (source.isM3U8 || url.endsWith('.m3u8') || type.includes('mpegurl')) return 'hls';
  if (url.endsWith('.mpd') || type.includes('dash')) return 'dash';
  if (url.endsWith('.mp4') || type.includes('mp4')) return 'mp4';
  return 'unknown';
}

function safeHost(value: string): string {
  try { return new URL(value).host; } catch { return 'invalid-url'; }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const u = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,HEAD,OPTIONS', 'Access-Control-Allow-Headers': '*' } });
    if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('method not allowed', { status: 405, headers: { Allow: 'GET, HEAD, OPTIONS' } });

    if (u.pathname === '/api/hls') {
      const target = u.searchParams.get('u');
      const ref = u.searchParams.get('r') ?? '';
      if (!target) return new Response('missing u', { status: 400 });
      let mediaUrl: URL;
      try { mediaUrl = new URL(target); } catch { return new Response('invalid u', { status: 400 }); }
      const rules = parseProviderHostRules(env.HLS_ALLOWED_HOSTS);
      if (!rules.length) return new Response('HLS proxy is not configured', { status: 503 });
      if (ref) { try { const referer = new URL(ref); if (referer.protocol !== 'https:' || referer.username || referer.password) return new Response('invalid referer', { status: 400 }); } catch { return new Response('invalid referer', { status: 400 }); } }
      const upstream = await fetchAllowed(mediaUrl, ref, req.headers.get('Range'), rules, req.signal, req.method);
      if (!upstream.ok && upstream.status !== 206) return new Response('upstream media fetch failed', { status: upstream.status });
      const type = upstream.headers.get('Content-Type') ?? '';
      const isManifest = type.toLowerCase().includes('mpegurl') || mediaUrl.pathname.toLowerCase().endsWith('.m3u8');
      if (isManifest && req.method !== 'HEAD') {
        const body = await upstream.text();
        if (!body.slice(0, 512).includes('#EXTM3U')) return new Response('invalid HLS manifest', { status: 502 });
        return new Response(rewriteApiManifest(body, mediaUrl, ref), { status: upstream.status, headers: { 'Content-Type': 'application/vnd.apple.mpegurl', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' } });
      }
      const response = cors(upstream, isManifest ? 'application/vnd.apple.mpegurl' : type || 'application/octet-stream');
      const responseHeaders = new Headers(response.headers);
      responseHeaders.set('Cache-Control', 'no-store');
      if (upstream.headers.has('Accept-Ranges')) responseHeaders.set('Accept-Ranges', upstream.headers.get('Accept-Ranges')!);
      return new Response(req.method === 'HEAD' ? null : response.body, { status: response.status, headers: responseHeaders });
    }

    // Browser-facing Consumet API proxy. All provider search/info/watch calls remain live API requests.
    if (u.pathname.startsWith('/api/') && u.pathname !== '/api/hls' && !u.pathname.startsWith('/api/hls/')) {
      const endpoint = `${u.pathname.slice(4)}${u.search}`;
      const provider = u.pathname.split('/')[3] ?? 'unknown';
      const stage = u.pathname.includes('/watch/') ? 'source-extraction' : u.pathname.includes('/info') ? 'metadata-and-episode-extraction' : 'search';
      const capability = stage === 'source-extraction' ? 'SOURCE_WORKING' : stage === 'metadata-and-episode-extraction' ? 'METADATA_WORKING' : 'SEARCH_WORKING';
      const upstreamUrl = `${env.RESOLVER}${endpoint}`;
      let upstream: Response;
      try {
        upstream = await fetch(upstreamUrl, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
      } catch (error) {
        console.error(`[Consumet] provider=${provider} capability=${capability}=broken endpoint=${endpoint} upstream=${safeHost(upstreamUrl)} status=network-error body=${String(error).slice(0, 300)}`);
        return Response.json({ error: 'Consumet API is unreachable', diagnostic: 'Локалният Consumet API не отговаря. Провери дали работи на порт 3000.', provider, endpoint, upstreamStatus: 502 }, { status: 502, headers: { 'Access-Control-Allow-Origin': '*' } });
      }
      console.info(`[Consumet] provider=${provider} capability=${capability} stage=${stage} endpoint=${endpoint} upstream=${safeHost(upstreamUrl)} status=${upstream.status}`);
      if (!upstream.ok) {
        const excerpt = (await upstream.clone().text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 400);
        console.error(`[Consumet] provider=${provider} capability=${capability}=broken stage=${stage} endpoint=${endpoint} upstream=${safeHost(upstreamUrl)} status=${upstream.status} body=${excerpt}`);
        const diagnostic = upstream.status === 404
          ? `Consumet няма маршрут за доставчик „${provider}“ и заявка „${endpoint}“ (HTTP 404). Провери наличните route-и на тази fork версия.`
          : `Consumet върна HTTP ${upstream.status} за „${endpoint}“. Провери лога на локалния API.`;
        return Response.json({ error: 'Consumet request failed', diagnostic, provider, endpoint, upstreamStatus: upstream.status }, { status: upstream.status, headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' } });
      }
      const payload = await upstream.clone().json().catch(() => null) as { results?: unknown[]; episodes?: unknown[]; sources?: Array<{ url?: string; isM3U8?: boolean; type?: string; headers?: Record<string, string> }> } | null;
      if (stage === 'search') console.info(`[Consumet] provider=${provider} capability=SEARCH_WORKING state=${Array.isArray(payload?.results) ? 'working' : 'broken'} resultCount=${payload?.results?.length ?? 0}`);
      if (stage === 'metadata-and-episode-extraction') console.info(`[Consumet] provider=${provider} capability=METADATA_WORKING state=${payload ? 'working' : 'broken'} capability=EPISODES_WORKING state=${payload?.episodes?.length ? 'working' : 'broken'} episodes=${payload?.episodes?.length ?? 0}`);
      if (stage === 'source-extraction') console.info(`[Consumet] provider=${provider} capability=SOURCE_WORKING state=${payload?.sources?.length ? 'working' : 'broken'} count=${payload?.sources?.length ?? 0} formats=${[...new Set((payload?.sources ?? []).map(mediaKind))].join(',') || 'none'} headerNames=${[...new Set((payload?.sources ?? []).flatMap(source => Object.keys(source.headers ?? {})))].join(',') || 'none'}`);
      return cors(upstream);
    }

    if (u.pathname.startsWith('/p/') || u.pathname.startsWith('/api/hls/')) {
      const normalizedPath = u.pathname.startsWith('/api/hls/') ? `/p/${u.pathname.slice('/api/hls/'.length)}` : u.pathname;
      const [, , provider, ...episodeParts] = normalizedPath.split('/');
      if (provider === 'test') {
        if (!env.TEST_HLS_URL) return new Response('test stream is not configured', { status: 404 });
        const ref = '';
        const rules = parseProviderHostRules(env.HLS_ALLOWED_HOSTS);
        const manifest = await fetchAllowed(new URL(env.TEST_HLS_URL), ref, null, rules, req.signal, req.method);
        if (!manifest.ok) return new Response('test manifest fetch failed', { status: 502 });
        return new Response(req.method === 'HEAD' ? null : rewriteManifest(await manifest.text(), new URL(env.TEST_HLS_URL), ref), { headers: { 'Content-Type': 'application/vnd.apple.mpegurl', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' } });
      }
      if (provider === 'test-mp4') {
        if (!env.TEST_MP4_URL) return new Response('MP4 test source is not configured', { status: 404 });
        const rules = parseProviderHostRules(env.HLS_ALLOWED_HOSTS);
        const media = await fetchAllowed(new URL(env.TEST_MP4_URL), '', req.headers.get('Range'), rules, req.signal, req.method);
        const response = cors(media, media.headers.get('Content-Type') ?? 'video/mp4');
        const responseHeaders = new Headers(response.headers);
        responseHeaders.set('Cache-Control', 'no-store');
        responseHeaders.set('Accept-Ranges', media.headers.get('Accept-Ranges') ?? 'bytes');
        return new Response(response.body, { status: media.status, headers: responseHeaders });
      }
      const episodeId = decodeURIComponent(episodeParts.join('/'));
      const path = `/anime/${encodeURIComponent(provider)}/watch/${encodeURIComponent(episodeId)}`;
      const upstreamUrl = `${env.RESOLVER}${path}`;
      let resolved: Response;
      try {
        resolved = await fetch(upstreamUrl, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
      } catch (error) {
        console.error(`[Playback] provider=${provider} capability=SOURCE_WORKING=broken stage=source-extraction endpoint=${path} status=network-error body=${String(error).slice(0, 300)}`);
        return new Response('Consumet stream resolution failed', { status: 502 });
      }
      console.info(`[Playback] provider=${provider} capability=SOURCE_WORKING stage=source-extraction endpoint=${path} upstream=${safeHost(upstreamUrl)} status=${resolved.status}`);
      if (!resolved.ok) {
        const excerpt = (await resolved.clone().text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 400);
        console.error(`[Playback] provider=${provider} capability=SOURCE_WORKING=broken stage=source-extraction endpoint=${path} status=${resolved.status} body=${excerpt}`);
        return new Response('Consumet stream resolution failed', { status: 502 });
      }
      const data = await resolved.json() as { sources?: Array<{ url: string; isM3U8?: boolean; type?: string; quality?: string; headers?: Record<string, string> }> };
      const sources = data.sources ?? [];
      console.info(`[Playback] provider=${provider} capability=SOURCE_WORKING state=${sources.length ? 'working' : 'broken'} stage=source-metadata count=${sources.length} formats=${[...new Set(sources.map(mediaKind))].join(',') || 'none'} headerNames=${[...new Set(sources.flatMap(source => Object.keys(source.headers ?? {})))].join(',') || 'none'}`);
      const isHls = (item: typeof sources[number]) => item.isM3U8 || item.url.toLowerCase().split('?')[0].endsWith('.m3u8') || item.type?.toLowerCase().includes('mpegurl');
      const isMp4 = (item: typeof sources[number]) => item.url.toLowerCase().split('?')[0].endsWith('.mp4') || item.type?.toLowerCase().includes('mp4');
      const isDash = (item: typeof sources[number]) => item.url.toLowerCase().split('?')[0].endsWith('.mpd') || item.type?.toLowerCase().includes('dash');
      const source = sources.find(isHls);
      if (!source) {
        const mp4 = sources.find(isMp4);
        if (mp4) {
          const ref = new URL(mp4.url).origin + '/';
          const headers = new Headers(mp4.headers ?? {});
          if (!headers.has('Referer')) headers.set('Referer', ref);
          if (!headers.has('User-Agent')) headers.set('User-Agent', UA);
          const range = req.headers.get('Range');
          if (range) headers.set('Range', range);
          const rules = parseProviderHostRules(env.HLS_ALLOWED_HOSTS);
          if (!rules.length) return new Response('HLS proxy is not configured', { status: 503 });
          const media = await fetchAllowed(new URL(mp4.url), ref, req.headers.get('Range'), rules, req.signal);
          console.info(`[Playback] provider=${provider} stage=media-fetch format=mp4 host=${safeHost(mp4.url)} status=${media.status} contentType=${media.headers.get('Content-Type') ?? 'unknown'} range=${media.headers.get('Accept-Ranges') ?? 'unknown'} headerNames=${[...headers.keys()].join(',')}`);
          if (!media.ok && media.status !== 206) {
            const excerpt = (await media.clone().text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300);
            console.error(`[Playback] provider=${provider} stage=media-fetch format=mp4 host=${safeHost(mp4.url)} status=${media.status} body=${excerpt}`);
            return new Response('MP4 source fetch failed', { status: 502 });
          }
          const response = cors(media, media.headers.get('Content-Type') ?? 'video/mp4');
          const responseHeaders = new Headers(response.headers);
          responseHeaders.set('Cache-Control', 'no-store');
          responseHeaders.set('Accept-Ranges', media.headers.get('Accept-Ranges') ?? 'bytes');
          return new Response(response.body, { status: media.status, headers: responseHeaders });
        }
        if (sources.some(isDash)) return Response.json({ error: 'DASH source is not supported by the current player', sourceType: 'dash' }, { status: 415, headers: { 'Access-Control-Allow-Origin': '*' } });
        return Response.json({ error: sources.length ? 'No supported stream format was returned' : 'No stream sources were returned', sourceType: sources.length ? 'unsupported' : 'unavailable' }, { status: sources.length ? 415 : 502, headers: { 'Access-Control-Allow-Origin': '*' } });
      }
      const ref = new URL(source.url).origin + '/';
      const headers = new Headers(source.headers ?? {});
      if (!headers.has('Referer')) headers.set('Referer', ref);
      if (!headers.has('User-Agent')) headers.set('User-Agent', UA);
      const rules = parseProviderHostRules(env.HLS_ALLOWED_HOSTS);
      if (!rules.length) return new Response('HLS proxy is not configured', { status: 503 });
      const manifest = await fetchAllowed(new URL(source.url), ref, null, rules, req.signal);
      console.info(`[Playback] provider=${provider} stage=media-fetch format=hls host=${safeHost(source.url)} status=${manifest.status} contentType=${manifest.headers.get('Content-Type') ?? 'unknown'} headerNames=${[...headers.keys()].join(',')}`);
      if (!manifest.ok) {
        const excerpt = (await manifest.clone().text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300);
        console.error(`[Playback] provider=${provider} stage=media-fetch format=hls host=${safeHost(source.url)} status=${manifest.status} body=${excerpt}`);
        return new Response('manifest fetch failed', { status: 502 });
      }
      const text = await manifest.text();
      let output = rewriteManifest(text, new URL(source.url), ref);
      if (output.includes('#EXT-X-STREAM-INF')) {
        const subtitlePath = `/subs/${encodeURIComponent(u.searchParams.get('slug') ?? provider)}/${encodeURIComponent(u.searchParams.get('ep') ?? episodeId)}.vtt`;
        output = output.replace('#EXTM3U', `#EXTM3U\n#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Български",LANGUAGE="bg",DEFAULT=YES,AUTOSELECT=YES,URI="${subtitlePath}"`)
          .replace(/(#EXT-X-STREAM-INF:[^\n]*)/g, '$1,SUBTITLES="subs"');
      }
      return new Response(output, { headers: { 'Content-Type': 'application/vnd.apple.mpegurl', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=30' } });
    }

    if (u.pathname === '/s') {
      const target = u.searchParams.get('u');
      const ref = u.searchParams.get('r') ?? '';
      if (!target) return new Response('missing u', { status: 400 });
      let mediaUrl: URL;
      try { mediaUrl = new URL(target); } catch { return new Response('invalid u', { status: 400 }); }
      const rules = parseProviderHostRules(env.HLS_ALLOWED_HOSTS);
      if (!rules.length) return new Response('HLS proxy is not configured', { status: 503 });
      const upstream = await fetchAllowed(mediaUrl, ref, req.headers.get('Range'), rules, req.signal);
      const type = upstream.headers.get('Content-Type') ?? '';
      if (type.includes('mpegurl') || new URL(target).pathname.endsWith('.m3u8')) {
        return new Response(rewriteManifest(await upstream.text(), new URL(target), ref), { status: upstream.status, headers: { 'Content-Type': 'application/vnd.apple.mpegurl', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=30' } });
      }
      return cors(upstream, type || 'video/mp2t');
    }

    return new Response('not found', { status: 404 });
  },
};

interface Env { RESOLVER: string; TEST_HLS_URL?: string; TEST_MP4_URL?: string; HLS_ALLOWED_HOSTS?: string }
