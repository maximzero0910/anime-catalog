import { fetch as undiciFetch } from 'undici';
import { Impit } from 'impit';
import { UA } from '../../lib/providers/types';

export const prerender = false;

function rewriteManifest(text: string, base: URL, referer: string): string {
  const proxy = (value: string) => `/api/hls?u=${encodeURIComponent(new URL(value, base).href)}&r=${encodeURIComponent(referer)}`;
  return text.split('\n').map(line => {
    if (!line || line.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_whole, uri: string) => `URI="${proxy(uri)}"`);
    return proxy(line.trim());
  }).join('\n');
}

async function fetchWithFallback(url: URL, init: RequestInit): Promise<Response> {
  const response = await undiciFetch(url, init as Parameters<typeof undiciFetch>[1]) as unknown as Response;
  if (response.status !== 403) return response;
  return await new Impit({ browser: 'chrome' }).fetch(url, init as never) as unknown as Response;
}

export async function GET({ request }: { request: Request }): Promise<Response> {
  return proxyRequest(request);
}

export async function HEAD({ request }: { request: Request }): Promise<Response> {
  return proxyRequest(request);
}

async function proxyRequest(request: Request): Promise<Response> {
  const incoming = new URL(request.url);
  const target = incoming.searchParams.get('u');
  const referer = incoming.searchParams.get('r') ?? '';
  if (!target) return new Response('missing u', { status: 400 });
  let url: URL;
  try { url = new URL(target); } catch { return new Response('invalid u', { status: 400 }); }
  if (!['http:', 'https:'].includes(url.protocol)) return new Response('invalid protocol', { status: 400 });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  let upstream: Response;
  try {
    const headers: Record<string, string> = { 'user-agent': UA };
    if (referer) headers.referer = referer;
    const range = request.headers.get('range');
    if (range) headers.range = range;
    upstream = await fetchWithFallback(url, { method: request.method, headers, signal: controller.signal });
  } catch (error) {
    const timedOut = controller.signal.aborted;
    return Response.json({ error: timedOut ? 'timeout' : 'upstream-network-error' }, { status: timedOut ? 504 : 502 });
  } finally {
    clearTimeout(timer);
  }
  const type = upstream.headers.get('content-type') ?? '';
  const isManifest = type.toLowerCase().includes('mpegurl') || url.pathname.toLowerCase().endsWith('.m3u8');
  const headers = new Headers({ 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
  headers.set('Content-Type', isManifest ? 'application/vnd.apple.mpegurl' : type || 'application/octet-stream');
  for (const name of ['accept-ranges', 'content-range', 'content-length']) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (!upstream.ok && upstream.status !== 206) return new Response('upstream media fetch failed', { status: upstream.status, headers });
  if (request.method === 'HEAD') return new Response(null, { status: upstream.status, headers });
  if (isManifest) {
    const text = await upstream.text();
    if (text.length <= 40 || !text.slice(0, 512).includes('#EXTM3U')) return new Response('invalid HLS manifest', { status: 502 });
    return new Response(rewriteManifest(text, url, referer), { status: upstream.status, headers });
  }
  return new Response(upstream.body, { status: upstream.status, headers });
}
