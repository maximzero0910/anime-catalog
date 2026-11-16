import { fetchPublic, ProxyError } from '../../lib/hls-proxy';
import { UA } from '../../lib/providers/types';

export const prerender = false;

function rewriteManifest(text: string, base: URL, referer: string): string {
  const proxy = (value: string) => `/api/hls?u=${encodeURIComponent(new URL(value, base).href)}&r=${encodeURIComponent(referer)}`;
  return text.split('\n').map(line => line.startsWith('#') ? line.replace(/URI="([^"]+)"/g, (_whole, uri: string) => `URI="${proxy(uri)}"`) : line.trim() ? proxy(line.trim()) : line).join('\n');
}

export async function GET({ request }: { request: Request }): Promise<Response> { return proxyRequest(request); }
export async function HEAD({ request }: { request: Request }): Promise<Response> { return proxyRequest(request); }

async function proxyRequest(request: Request): Promise<Response> {
  const incoming = new URL(request.url);
  const target = incoming.searchParams.get('u');
  const referer = incoming.searchParams.get('r') ?? '';
  if (!target) return new Response('missing u', { status: 400 });
  let url: URL;
  try { url = new URL(target); } catch { return new Response('invalid u', { status: 400 }); }
  if (url.protocol !== 'https:') return new Response('https required', { status: 400 });
  if (referer) {
    try { const ref = new URL(referer); if (ref.protocol !== 'https:' || ref.username || ref.password) throw new Error(); }
    catch { return new Response('invalid referer', { status: 400 }); }
  }
  const rules = (process.env.HLS_ALLOWED_HOSTS ?? '').split(',').map(value => value.trim()).filter(Boolean);
  if (!rules.length) return new Response('HLS proxy is not configured', { status: 503 });
  const headers: Record<string, string> = { 'user-agent': UA, accept: '*/*' };
  if (referer) headers.referer = referer;
  const range = request.headers.get('range');
  if (range && /^bytes=\d*-\d*(,\d*-\d*)*$/.test(range)) headers.range = range;
  let upstream: Response;
  try { upstream = await fetchPublic(url, { method: request.method, headers }, rules, request.signal); }
  catch (error) {
    const status = error instanceof ProxyError ? error.status : 502;
    return Response.json({ error: error instanceof ProxyError ? error.message : 'upstream-failed' }, { status, headers: { 'cache-control': 'no-store' } });
  }
  const type = upstream.headers.get('content-type') ?? '';
  const isManifest = type.toLowerCase().includes('mpegurl') || url.pathname.toLowerCase().endsWith('.m3u8');
  const responseHeaders = new Headers({ 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  responseHeaders.set('Content-Type', isManifest ? 'application/vnd.apple.mpegurl' : type || 'application/octet-stream');
  for (const name of ['accept-ranges', 'content-range']) { const value = upstream.headers.get(name); if (value) responseHeaders.set(name, value); }
  if (request.method === 'HEAD' || !upstream.body) return new Response(null, { status: upstream.status, headers: responseHeaders });
  if (isManifest) return new Response(rewriteManifest(await upstream.text(), url, referer), { status: upstream.status, headers: responseHeaders });
  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}
