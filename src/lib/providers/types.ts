import { fetch as undiciFetch } from 'undici';
import { runInNewContext } from 'node:vm';

export type AudioMode = 'sub' | 'dub';
export type Quality = '1080' | '720' | '480' | '360' | 'auto';

export interface StreamSource {
  url: string;
  quality: Quality;
  type: 'hls' | 'mp4';
  headers: Record<string, string>;
  subtitles: { lang: string; url: string; format: 'vtt' | 'ass' | 'srt' }[];
  audio: AudioMode;
  provider: string;
}

export interface SearchHit { id: string; title: string; year?: number; alt?: string[] }
export interface EpisodeRef { num: number; id: string }

export interface Provider {
  readonly id: string;
  weight: number;
  score: number;
  searchByTitle(q: string): Promise<SearchHit[]>;
  listEpisodes(seriesId: string): Promise<EpisodeRef[]>;
  resolve(episodeId: string, mode: AudioMode): Promise<StreamSource[]>;
  health(): Promise<boolean>;
}

export type ProviderErrorKind = 'network' | 'blocked' | 'empty' | 'parse' | 'timeout';
export class ProviderError extends Error {
  constructor(readonly kind: ProviderErrorKind, readonly provider: string, message = `${provider}: ${kind}`) {
    super(message);
    this.name = 'ProviderError';
  }
}

export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function transport(url: string, init: RequestInit, provider: string): Promise<Response> {
  const useImpit = provider === 'animepahe' || new URL(url).hostname.toLowerCase().includes('kwik');
  let response: Response;
  if (useImpit) {
    const { Impit } = await import('impit');
    response = await new Impit({ browser: 'chrome' }).fetch(url, init as never) as unknown as Response;
  } else {
    response = await undiciFetch(url, init as Parameters<typeof undiciFetch>[1]) as unknown as Response;
    if (response.status === 403) {
      const { Impit } = await import('impit');
      response = await new Impit({ browser: 'chrome' }).fetch(url, init as never) as unknown as Response;
    }
  }
  return response;
}

export async function httpGet(
  url: string,
  options: { headers?: Record<string, string>; referer?: string; timeoutMs?: number; retries?: number; provider: string; returnHttpErrors?: boolean; returnBlockedResponse?: boolean; responseType?: 'text' | 'bytes'; method?: 'GET' | 'HEAD' },
): Promise<{ status: number; text: string; headers: Headers; finalUrl: string; bytes?: Uint8Array }> {
  const { headers: extra = {}, referer, timeoutMs = 12000, retries = 2, provider, returnHttpErrors = false, returnBlockedResponse = false, responseType = 'text', method = 'GET' } = options;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await transport(url, { method, headers: { 'user-agent': UA, ...(referer ? { referer } : {}), ...extra }, signal: controller.signal }, provider);
      const bytes = responseType === 'bytes' ? new Uint8Array(await response.arrayBuffer()) : undefined;
      const text = bytes ? new TextDecoder().decode(bytes) : await response.text();
      if (response.status === 403 && !returnBlockedResponse) throw new ProviderError('blocked', provider, `${provider}: HTTP 403`);
      if (returnHttpErrors && (response.status === 429 || response.status >= 500)) return { status: response.status, text, headers: response.headers, finalUrl: response.url, ...(bytes ? { bytes } : {}) };
      if (response.status === 429 || response.status >= 500) {
        if (attempt < retries) {
          await new Promise(resolve => setTimeout(resolve, Math.random() * 250 * (2 ** attempt)));
          continue;
        }
        throw new ProviderError('network', provider, `${provider}: HTTP ${response.status}`);
      }
      return { status: response.status, text, headers: response.headers, finalUrl: response.url, ...(bytes ? { bytes } : {}) };
    } catch (error) {
      if (error instanceof ProviderError && error.kind === 'blocked') throw error;
      if (controller.signal.aborted) throw new ProviderError('timeout', provider, `${provider}: request timed out`);
      lastError = error;
      if (attempt < retries) {
        await new Promise(resolve => setTimeout(resolve, Math.random() * 250 * (2 ** attempt)));
        continue;
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw new ProviderError('network', provider, `${provider}: ${String(lastError ?? 'request failed')}`);
}

export async function httpPost(url: string, body: string, options: { headers?: Record<string, string>; referer?: string; timeoutMs?: number; retries?: number; provider: string; returnHttpErrors?: boolean; returnBlockedResponse?: boolean }): Promise<{ status: number; text: string; headers: Headers; finalUrl: string }> {
  const { headers: extra = {}, referer, timeoutMs = 12000, retries = 2, provider, returnHttpErrors = false, returnBlockedResponse = false } = options;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await transport(url, { method: 'POST', body, headers: { 'user-agent': UA, 'content-type': 'application/json', ...(referer ? { referer } : {}), ...extra }, signal: controller.signal }, provider);
      const text = await response.text();
      if (response.status === 403 && !returnBlockedResponse) throw new ProviderError('blocked', provider, `${provider}: HTTP 403`);
      if (returnHttpErrors && (response.status === 429 || response.status >= 500)) return { status: response.status, text, headers: response.headers, finalUrl: response.url };
      if ((response.status === 429 || response.status >= 500) && attempt < retries) {
        await new Promise(resolve => setTimeout(resolve, Math.random() * 250 * (2 ** attempt)));
        continue;
      }
      return { status: response.status, text, headers: response.headers, finalUrl: response.url };
    } catch (error) {
      if (error instanceof ProviderError && error.kind === 'blocked') throw error;
      if (controller.signal.aborted) throw new ProviderError('timeout', provider, `${provider}: request timed out`);
      lastError = error;
      if (attempt < retries) { await new Promise(resolve => setTimeout(resolve, Math.random() * 250 * (2 ** attempt))); continue; }
    } finally { clearTimeout(timer); }
  }
  throw new ProviderError('network', provider, `${provider}: ${String(lastError ?? 'request failed')}`);
}

export function strictDomStub(name: string, shape: Record<string, unknown> = {}): Record<string, unknown> {
  return new Proxy(shape, {
    get(target, property) {
      if (typeof property === 'string' && Object.hasOwn(target, property)) return target[property];
      throw new Error(`Unsupported ${name}.${String(property)} access in browserless extraction`);
    },
    set(_target, property) { throw new Error(`Unsupported ${name}.${String(property)} write in browserless extraction`); },
  });
}

export function runBrowserlessScript<T>(script: string, resultExpression: string, context: Record<string, unknown> = {}): T {
  const document = context.document ?? strictDomStub('document');
  const window = context.window ?? strictDomStub('window');
  return runInNewContext(`"use strict"; ${script}\n;(${resultExpression})`, { ...context, document, window, atob: (value: string) => Buffer.from(value, 'base64').toString('binary') }, { timeout: 1000 }) as T;
}

export function evaluateMiruroPipe<T>(pipeScript: string, resultExpression: string, context: Record<string, unknown> = {}): T {
  return runBrowserlessScript<T>(pipeScript, resultExpression, context);
}

export function evaluateKwikPackedPlayer<T>(playerScript: string, resultExpression: string, context: Record<string, unknown> = {}): T {
  return runBrowserlessScript<T>(playerScript, resultExpression, context);
}

export async function verifyPlaylist(url: string, headers: Record<string, string> = {}): Promise<boolean> {
  try {
    const result = await httpGet(url, { headers, timeoutMs: 12000, retries: 0, provider: 'playlist' });
    return result.status >= 200 && result.status < 300 && result.text.length > 40 && result.text.slice(0, 512).includes('#EXTM3U');
  } catch {
    return false;
  }
}

/** Check the first media segment as well as the manifest. Some mirror hosts
 * return valid-looking HLS playlists whose segment URLs are ad images. */
export async function verifyPlayablePlaylist(url: string, headers: Record<string, string> = {}): Promise<boolean> {
  try {
    let playlistUrl = url;
    let playlist = await httpGet(playlistUrl, { headers, timeoutMs: 12000, retries: 0, provider: 'playlist' });
    if (playlist.status < 200 || playlist.status >= 300 || playlist.text.length <= 40 || !playlist.text.slice(0, 512).includes('#EXTM3U')) return false;
    let mediaUrl: string | undefined;
    const lines = playlist.text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const variant = lines.find((line, index) => line.startsWith('#EXT-X-STREAM-INF') && lines.slice(index + 1).find(item => !item.startsWith('#')));
    if (variant) {
      const index = lines.indexOf(variant);
      const child = lines.slice(index + 1).find(line => !line.startsWith('#'));
      if (!child) return false;
      playlistUrl = new URL(child, playlistUrl).href;
      playlist = await httpGet(playlistUrl, { headers, timeoutMs: 12000, retries: 0, provider: 'playlist' });
      if (playlist.status < 200 || playlist.status >= 300 || playlist.text.length <= 40 || !playlist.text.slice(0, 512).includes('#EXTM3U')) return false;
    }
    const mediaLines = playlist.text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    mediaUrl = mediaLines.find(line => line && !line.startsWith('#'));
    if (!mediaUrl) return false;
    const segmentUrl = new URL(mediaUrl, playlistUrl).href;
    const segment = await httpGet(segmentUrl, { headers, timeoutMs: 12000, retries: 0, provider: 'playlist' });
    if (segment.status < 200 || segment.status >= 300) return false;
    const contentType = segment.headers.get('content-type')?.toLowerCase() ?? '';
    const signature = segment.text;
    if (/text\/html/.test(contentType) || /^\s*(?:<!doctype html|<html|<\?xml)/i.test(signature.slice(0, 80))) return false;
    // MegaPlay disguises MPEG-TS fragments as .jpg and serves them with
    // image/jpeg. Check the 188-byte TS sync cadence before rejecting that MIME.
    const isTransportStream = [0, 188, 376].every(offset => signature.charCodeAt(offset) === 0x47);
    if (/image\//.test(contentType) && !isTransportStream) return false;
    if (signature.startsWith('\uFFFDPNG') && !isTransportStream) return false;
    return true;
  } catch { return false; }
}

export function qualityFrom(s: string): Quality {
  const match = s.match(/(?:^|\D)(1080|720|480|360)(?:p)?(?:\D|$)/i);
  return match ? match[1] as Quality : 'auto';
}

export function firstMatch(html: string, regexes: RegExp[]): string | undefined {
  for (const regex of regexes) {
    const match = regex.exec(html);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

export function allMatches(html: string, regex: RegExp): string[][] {
  const flags = regex.flags.includes('g') ? regex.flags : `${regex.flags}g`;
  const matcher = new RegExp(regex.source, flags);
  return Array.from(html.matchAll(matcher), match => Array.from(match));
}

export function abs(base: string, href: string): string {
  return new URL(href, base).href;
}

