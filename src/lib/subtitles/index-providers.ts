import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { httpGet, httpPost, UA } from '../providers/types';
import { indexerHttpCache, saveIndexerHttpCache, type SubtitleIndexInput } from './storage';

export interface SubtitleAnimeIds {
  animeId: string;
  anidbId?: string | null;
  imdbId?: string | null;
  title: string;
  aliases?: string[];
  season?: number | null;
  episode: number;
  durationMs?: number | null;
  fileHash?: string | null;
  releaseGroup?: string | null;
}

export interface SubtitleCandidate extends SubtitleIndexInput {
  filename?: string;
  providerRef?: Record<string, string | number | null>;
}

export interface DownloadedSubtitle { body: string; format: 'srt' | 'ass' | 'ssa' | 'vtt'; language: string; }
export interface SubtitleIndexProvider {
  readonly id: string;
  search(animeIds: SubtitleAnimeIds, season: number | null, episode: number): Promise<SubtitleCandidate[]>;
  fetch(indexRow: SubtitleCandidate): Promise<DownloadedSubtitle>;
}

type TextResult = { status: number; text: string; headers: Headers; finalUrl: string };
type ByteResult = { status: number; bytes: Uint8Array; headers: Headers; finalUrl: string };
type Slot = { active: number; waiting: Array<() => void> };
const hostSlots = new Map<string, Slot>();
// DECISION: serialize forum archives and keep API/feed hosts narrowly capped to protect public services during overnight indexing.
const hostCaps: Record<string, number> = { 'subsunacs.net': 1, 'subs.sab.bz': 1, 'api.opensubtitles.com': 2, 'anima-pr.blogspot.com': 1, 'api.github.com': 2, 'raw.githubusercontent.com': 3 };
const sabCookies = new Map<string, string>();
const openSeasonCache = new Map<string, Promise<OpenSubtitlesRecord[]>>();
let animeArchiveRows: SubtitleCandidate[] | undefined;
let animeArchiveBranch = 'main';
let animeArchiveByAniDb = new Map<string, SubtitleCandidate[]>();
let animeArchiveByTitle = new Map<string, SubtitleCandidate[]>();
let aniMaEntries: AniMaEntry[] | undefined;
let aniMaFetchedAt = 0;

interface OpenSubtitlesRecord { fileId: string; language: string; release?: string; season?: number; episode?: number; url: string; imdbId?: string; }
interface OpenSubtitlesPayload { data?: Array<{ attributes?: { language?: string; release?: string; files?: Array<{ file_id?: number; file_name?: string }>; feature_details?: { season_number?: number; episode_number?: number; imdb_id?: number } } }> }
interface AniMaEntry { title: string; aliases: string[]; url: string; providerId: string; }

export function normalizeSubtitleTitle(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

async function withHostSlot<T>(url: string, task: () => Promise<T>): Promise<T> {
  const hostname = new URL(url).hostname.toLowerCase();
  const cap = hostCaps[hostname] ?? 3;
  let slot = hostSlots.get(hostname);
  if (!slot) { slot = { active: 0, waiting: [] }; hostSlots.set(hostname, slot); }
  if (slot.active >= cap) await new Promise<void>(resolve => slot!.waiting.push(resolve));
  slot.active++;
  try { return await task(); }
  finally { slot.active--; slot.waiting.shift()?.(); }
}

function retryDelay(response: { headers: Headers }, attempt: number): number {
  const retryAfter = response.headers.get('retry-after');
  const seconds = retryAfter ? Number(retryAfter) : NaN;
  const dateDelay = retryAfter && !Number.isFinite(seconds) ? Date.parse(retryAfter) - Date.now() : NaN;
  const requested = Number.isFinite(seconds) ? seconds * 1000 : Number.isFinite(dateDelay) ? dateDelay : 1000 * 2 ** attempt;
  return Math.min(60_000, Math.max(500, requested)) + Math.floor(Math.random() * 250);
}

function cacheKey(method: string, url: string, body = ''): string { return createHash('sha256').update(`${method}\n${url}\n${body}`).digest('hex'); }

function headersForProvider(url: string, headers: Record<string, string> = {}): Record<string, string> {
  const hostname = new URL(url).hostname.toLowerCase();
  if (hostname !== 'subs.sab.bz') return headers;
  const cookie = sabCookies.get(hostname);
  return {
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.8,bg;q=0.7',
    Connection: 'keep-alive', 'User-Agent': UA, ...(cookie ? { Cookie: cookie } : {}), ...headers,
  };
}

function rememberProviderCookies(url: string, headers: Headers): void {
  const hostname = new URL(url).hostname.toLowerCase();
  if (hostname !== 'subs.sab.bz') return;
  const responseHeaders = headers as Headers & { getSetCookie?: () => string[] };
  const setCookies = responseHeaders.getSetCookie?.() ?? (headers.get('set-cookie') ? [headers.get('set-cookie')!] : []);
  if (!setCookies.length) return;
  const jar = new Map((sabCookies.get(hostname) ?? '').split(';').map(pair => pair.trim()).filter(Boolean).map(pair => {
    const split = pair.indexOf('='); return split < 0 ? [pair, ''] : [pair.slice(0, split), pair.slice(split + 1)];
  }));
  for (const value of setCookies) {
    const pair = value.split(';', 1)[0]?.trim();
    if (!pair) continue;
    const split = pair.indexOf('='); if (split < 1) continue;
    const name = pair.slice(0, split); const cookieValue = pair.slice(split + 1);
    if (/max-age=0|expires=Thu, 01 Jan 1970/i.test(value)) jar.delete(name); else jar.set(name, cookieValue);
  }
  sabCookies.set(hostname, [...jar].map(([name, value]) => `${name}=${value}`).join('; '));
}

async function requestText(url: string, options: { provider: string; method?: 'GET' | 'POST'; body?: string; headers?: Record<string, string>; referer?: string; timeoutMs?: number; cache?: boolean; json?: boolean; allowStatuses?: number[]; retry403?: boolean } ): Promise<TextResult> {
  const method = options.method ?? 'GET';
  const key = cacheKey(method, url, options.body ?? '');
  const cached = options.cache ? indexerHttpCache(key) : undefined;
  const headers = { ...(options.headers ?? {}), ...(cached?.etag ? { 'If-None-Match': cached.etag } : {}), ...(cached?.lastModified ? { 'If-Modified-Since': cached.lastModified } : {}) };
  return withHostSlot(url, async () => {
    const attempts = options.retry403 ? 3 : 4;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const response = method === 'POST'
        ? await httpPost(url, options.body ?? '', { provider: options.provider, headers: { ...(options.json ? { 'content-type': 'application/json' } : {}), ...headersForProvider(url, headers) }, referer: options.referer, timeoutMs: options.timeoutMs ?? 15000, retries: 0, returnHttpErrors: true, returnBlockedResponse: options.retry403 })
        : await httpGet(url, { provider: options.provider, headers: headersForProvider(url, headers), referer: options.referer, timeoutMs: options.timeoutMs ?? 15000, retries: 0, returnHttpErrors: true, returnBlockedResponse: options.retry403 });
      rememberProviderCookies(url, response.headers);
      if (response.status === 304 && cached?.body != null) return { ...response, status: cached.status ?? 200, text: cached.body };
      if (response.status === 403 && options.retry403) {
        if (attempt + 1 >= attempts) throw new Error(`${options.provider} returned HTTP 403 after ${attempts} browser-header attempts`);
        await new Promise(resolve => setTimeout(resolve, 10_000));
        continue;
      }
      if (response.status === 429 || response.status >= 500) {
        if (attempt + 1 >= attempts) throw new Error(`${options.provider} returned HTTP ${response.status}`);
        await new Promise(resolve => setTimeout(resolve, retryDelay(response, attempt)));
        continue;
      }
      if ((response.status < 200 || response.status >= 300) && !options.allowStatuses?.includes(response.status)) throw new Error(`${options.provider} returned HTTP ${response.status}`);
      if (options.cache) saveIndexerHttpCache(key, { etag: response.headers.get('etag'), lastModified: response.headers.get('last-modified'), body: response.text, status: response.status });
      return response;
    }
    throw new Error(`${options.provider} request retry ceiling reached`);
  });
}

async function requestBytes(url: string, options: { provider: string; headers?: Record<string, string>; referer?: string; timeoutMs?: number; retry403?: boolean }): Promise<ByteResult> {
  return withHostSlot(url, async () => {
    for (let attempt = 0; attempt < 4; attempt++) {
      const response = await httpGet(url, { provider: options.provider, headers: headersForProvider(url, options.headers), referer: options.referer, timeoutMs: options.timeoutMs ?? 30000, retries: 0, returnHttpErrors: true, returnBlockedResponse: options.retry403, responseType: 'bytes' });
      rememberProviderCookies(url, response.headers);
      if (response.status === 403 && options.retry403) {
        if (attempt + 1 >= 3) throw new Error(`${options.provider} returned HTTP 403 after 3 browser-header attempts`);
        await new Promise(resolve => setTimeout(resolve, 10_000));
        continue;
      }
      if (response.status === 429 || response.status >= 500) {
        if (attempt === 3) throw new Error(`${options.provider} returned HTTP ${response.status}`);
        await new Promise(resolve => setTimeout(resolve, retryDelay(response, attempt)));
        continue;
      }
      if (response.status < 200 || response.status >= 300) throw new Error(`${options.provider} returned HTTP ${response.status}`);
      return { status: response.status, bytes: response.bytes ?? new Uint8Array(), headers: response.headers, finalUrl: response.finalUrl };
    }
    throw new Error(`${options.provider} download retry ceiling reached`);
  });
}

function decodeHtml(value: string): string {
  return value.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&#(\d+);/g, (_all, n: string) => String.fromCodePoint(Number(n))).replace(/&#x([\da-f]+);/gi, (_all, n: string) => String.fromCodePoint(parseInt(n, 16)));
}
function stripTags(value: string): string { return decodeHtml(value.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim(); }
function absolutize(base: string, href: string): string { return new URL(decodeHtml(href), base).href; }
function language(value: string): string {
  const v = value.toLocaleLowerCase();
  return /(?:^|[\s._-])(bg|bul|bulgarian|български)(?:$|[\s._-])/.test(v) ? 'bg' : /(?:^|[\s._-])(ja|jpn|japanese|nihongo)(?:$|[\s._-])/.test(v) ? 'ja' : /(?:^|[\s._-])(en|eng|english)(?:$|[\s._-])/.test(v) ? 'en' : '';
}
function subtitleFormat(fileName: string, contentType = ''): 'srt' | 'ass' | 'ssa' | 'vtt' | '' {
  const ext = fileName.toLowerCase().match(/\.(srt|ass|ssa|vtt)(?:$|[?#])/i)?.[1]?.toLowerCase();
  if (ext) return ext as 'srt' | 'ass' | 'ssa' | 'vtt';
  const ct = contentType.toLowerCase();
  return ct.includes('vtt') ? 'vtt' : ct.includes('subrip') ? 'srt' : '';
}
function decodeSubtitle(bytes: Uint8Array): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, ''); }
  catch { return new TextDecoder('windows-1251').decode(bytes).replace(/^\uFEFF/, ''); }
}
function contentTypeFormat(bytes: Uint8Array, fileName: string, contentType = ''): 'srt' | 'ass' | 'ssa' | 'vtt' {
  const format = subtitleFormat(fileName, contentType);
  if (format) return format;
  const head = decodeSubtitle(bytes).slice(0, 2048);
  if (/\[Script Info\]|\[Events\]/i.test(head)) return /ScriptType:\s*v4\.00\+/i.test(head) ? 'ass' : 'ssa';
  if (/^\s*WEBVTT/m.test(head)) return 'vtt';
  return 'srt';
}

interface ZipEntry { name: string; bytes: Uint8Array; }
function zipSubtitleEntries(archive: Uint8Array): ZipEntry[] {
  const data = Buffer.from(archive);
  let end = -1;
  for (let i = Math.max(0, data.length - 65557); i <= data.length - 22; i++) if (data.readUInt32LE(i) === 0x06054b50) end = i;
  if (end < 0) return [];
  const count = data.readUInt16LE(end + 10); let offset = data.readUInt32LE(end + 16); const entries: ZipEntry[] = [];
  for (let i = 0; i < count && offset + 46 <= data.length; i++) {
    if (data.readUInt32LE(offset) !== 0x02014b50) break;
    const method = data.readUInt16LE(offset + 10); const compressedSize = data.readUInt32LE(offset + 20);
    const nameLength = data.readUInt16LE(offset + 28); const extraLength = data.readUInt16LE(offset + 30); const commentLength = data.readUInt16LE(offset + 32); const localOffset = data.readUInt32LE(offset + 42);
    const name = data.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    if (localOffset + 30 <= data.length && data.readUInt32LE(localOffset) === 0x04034b50 && /\.(srt|ass|ssa|vtt)$/i.test(name)) {
      const localName = data.readUInt16LE(localOffset + 26); const localExtra = data.readUInt16LE(localOffset + 28); const start = localOffset + 30 + localName + localExtra; const compressed = data.subarray(start, start + compressedSize);
      try { entries.push({ name, bytes: method === 0 ? new Uint8Array(compressed) : method === 8 ? new Uint8Array(inflateRawSync(compressed)) : new Uint8Array() }); } catch { /* A corrupt archive member is ignored while intact files remain usable. */ }
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries.filter(entry => entry.bytes.length > 0);
}
function episodeInName(name: string, season?: number | null): number | undefined {
  const pathParts = name.replaceAll('\\', '/').split('/').filter(Boolean);
  for (const part of pathParts.slice(0, -1).reverse()) if (/^\d{1,3}$/.test(part)) return Number(part);
  const base = pathParts.at(-1) ?? name;
  const match = base.match(/(?:^|[ ._-])(?:s\d{1,2}[ ._-]?)?e(?:p(?:isode)?)?[ ._-]?(\d{1,3})(?:\b|[ ._-])/i)
    ?? base.match(/(?:^|[ ._-])\d{1,2}x(\d{1,3})(?:\b|[ ._-])/i)
    ?? base.match(/\s-\s(\d{1,3})(?:\s|\[|\.|$)/);
  if (!match) return undefined;
  void season;
  return Number(match[1]);
}
function stableId(provider: string, value: string): string { return createHash('sha256').update(`${provider}\n${value}`).digest('hex'); }
function episodeSearchMatch(text: string, episode: number): number | undefined {
  const marker = text.match(/(?:^|[\s._-])(?:s\d{1,2}[\s._-]?)?e(?:p(?:isode)?)?[\s._-]?(\d{1,3})(?:\b|$)/i) ?? text.match(/(?:^|[\s._-])\d{1,2}x(\d{1,3})(?:\b|$)/i);
  return marker ? Number(marker[1]) : undefined;
}
function isTitleMatch(context: SubtitleAnimeIds, candidate: string): boolean {
  const name = normalizeSubtitleTitle(candidate);
  const aliases = [context.title, ...(context.aliases ?? [])].map(normalizeSubtitleTitle).filter(Boolean);
  return aliases.some(alias => name === alias || (name.length > alias.length + 5 && name.startsWith(`${alias} `)));
}

abstract class BaseProvider implements SubtitleIndexProvider {
  abstract readonly id: string;
  abstract search(animeIds: SubtitleAnimeIds, season: number | null, episode: number): Promise<SubtitleCandidate[]>;
  abstract fetch(indexRow: SubtitleCandidate): Promise<DownloadedSubtitle>;
  protected candidate(context: SubtitleAnimeIds, row: Omit<SubtitleCandidate, 'animeId' | 'anidbId' | 'imdbId' | 'episodeNumber' | 'language' | 'provider' | 'providerId' | 'qualityScore'> & { episodeNumber?: number; language: string; providerId: string }): SubtitleCandidate {
    return { ...row, animeId: context.animeId, anidbId: context.anidbId, imdbId: context.imdbId, episodeNumber: row.episodeNumber ?? context.episode, language: row.language, provider: this.id, providerId: row.providerId, qualityScore: 0, verified: false, fetchable: true };
  }
}

export class OpenSubtitlesProvider extends BaseProvider {
  readonly id = 'opensubtitles';
  private apiKey: string;
  private appUserAgent: string;
  constructor(private readonly request: typeof requestText = requestText, apiKey = process.env.OPEN_SUBTITLES_API_KEY ?? '', appUserAgent = `Anineko v${process.env.npm_package_version ?? '1.0.0'}`) { super(); this.apiKey = apiKey; this.appUserAgent = appUserAgent; }
  async search(animeIds: SubtitleAnimeIds, season: number | null, episode: number): Promise<SubtitleCandidate[]> {
    if (!this.apiKey) return [];
    const key = `${animeIds.animeId}:${animeIds.imdbId ?? ''}:${season ?? ''}:${animeIds.fileHash ?? ''}`;
    let batch = openSeasonCache.get(key);
    if (!batch) {
      batch = this.searchBatch(animeIds, season);
      openSeasonCache.set(key, batch);
    }
    const results = await batch;
    return results.filter(row => row.episode == null || row.episode === episode).map(row => this.candidate(animeIds, {
      providerId: row.fileId, episodeNumber: row.episode ?? episode, language: row.language,
      releaseGroup: row.release, fileHash: animeIds.fileHash ?? null, sourceUrl: row.url,
      attribution: 'OpenSubtitles', format: null, fetchable: true,
      providerRef: { fileId: row.fileId, imdbId: row.imdbId ?? animeIds.imdbId ?? null },
    }));
  }
  private async searchBatch(context: SubtitleAnimeIds, season: number | null): Promise<OpenSubtitlesRecord[]> {
    const search = async (useTitle: boolean) => {
      const params = new URLSearchParams({ languages: 'bg,en,ja' });
      if (context.fileHash) params.set('moviehash', context.fileHash);
      else if (context.imdbId) params.set('imdb_id', context.imdbId.replace(/^tt/i, ''));
      else if (useTitle) params.set('query', `${context.title}${season == null ? '' : ` ${season}x`}`);
      else return [];
      if (season != null && !context.fileHash) params.set('season_number', String(season));
      const url = `https://api.opensubtitles.com/api/v1/subtitles?${params}`;
      const response = await this.request(url, { provider: this.id, cache: true, headers: { 'Api-Key': this.apiKey, 'User-Agent': this.appUserAgent, Accept: 'application/json' } });
      const json = JSON.parse(response.text) as OpenSubtitlesPayload;
      return (json.data ?? []).flatMap(item => {
        const attributes = item.attributes ?? {}; const file = attributes.files?.[0];
        if (file?.file_id == null) return [];
        const lang = language(attributes.language ?? '');
        if (!lang) return [];
        return [{ fileId: String(file.file_id), language: lang, release: attributes.release ?? file.file_name, season: attributes.feature_details?.season_number, episode: attributes.feature_details?.episode_number, url: `https://api.opensubtitles.com/api/v1/download/${file.file_id}`, imdbId: attributes.feature_details?.imdb_id ? String(attributes.feature_details.imdb_id) : undefined }];
      });
    };
    const exact = await search(false);
    return exact.length ? exact : search(true);
  }
  async fetch(row: SubtitleCandidate): Promise<DownloadedSubtitle> {
    if (!this.apiKey) throw new Error('OPEN_SUBTITLES_API_KEY is not configured');
    const fileId = String(row.providerId);
    const download = await requestText('https://api.opensubtitles.com/api/v1/download', { provider: this.id, method: 'POST', body: JSON.stringify({ file_id: Number(fileId) }), json: true, headers: { 'Api-Key': this.apiKey, 'User-Agent': this.appUserAgent, Accept: 'application/json' }, cache: true });
    const link = (JSON.parse(download.text) as { link?: string }).link;
    if (!link) throw new Error('OpenSubtitles download response has no link');
    const bytes = await requestBytes(link, { provider: this.id });
    const format = contentTypeFormat(bytes.bytes, String(row.providerRef?.fileId ?? row.providerId), bytes.headers.get('content-type') ?? '');
    return { body: decodeSubtitle(bytes.bytes), format, language: row.language };
  }
}

const SUBSUNACS_BASE = 'https://subsunacs.net';
const SUBSUNACS_SEARCH = `${SUBSUNACS_BASE}/search.php`;
const SUBSSABBZ_BASE = 'http://subs.sab.bz';
const SUBSSABBZ_SEARCH = `${SUBSSABBZ_BASE}/index.php?`;

function parseSubsunacs(body: string, context: SubtitleAnimeIds, episode: number): Array<{ title: string; page: string; download: string; language: string; filename: string; releaseGroup: string | null }> {
  const output: Array<{ title: string; page: string; download: string; language: string; filename: string; releaseGroup: string | null }> = [];
  for (const row of body.matchAll(/<tr\b([^>]*)>([\s\S]*?)<\/tr>/gi)) {
    const attrs = row[1] ?? ''; const html = row[2] ?? '';
    if (!/onmouseover\s*=/i.test(attrs)) continue;
    const cells = [...html.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(match => match[1] ?? '');
    if (cells.length < 2) continue;
    const titleCell = cells.find(cell => /tdMovie|tooltip/i.test(cell)) ?? cells[0]!;
    const anchor = titleCell.match(/<a\b([^>]*)>([\s\S]*?)<\/a>/i);
    const href = anchor?.[1]?.match(/\bhref\s*=\s*['"]([^'"]+)['"]/i)?.[1];
    const shown = stripTags(anchor?.[2] ?? '');
    if (!href || !/\/subtitles\//i.test(href) || !isTitleMatch(context, shown)) continue;
    const foundEpisode = episodeSearchMatch(shown, episode);
    if (foundEpisode != null && foundEpisode !== episode) continue;
    const page = absolutize(`${SUBSUNACS_BASE}/`, href);
    const download = `${page.replace(/\/$/, '')}/!`;
    const filename = shown || `episode-${episode}`;
    const releaseGroup = filename.match(/\[([^\]]+)\]/)?.[1] ?? null;
    output.push({ title: shown, page, download, language: 'bg', filename, releaseGroup });
  }
  return output;
}

function parseSubssabbz(body: string, context: SubtitleAnimeIds, episode: number): Array<{ title: string; download: string; language: string; filename: string; releaseGroup: string | null }> {
  const output: Array<{ title: string; download: string; language: string; filename: string; releaseGroup: string | null }> = [];
  for (const row of body.matchAll(/<tr\b([^>]*)>([\s\S]*?)<\/tr>/gi)) {
    if (!/\bclass\s*=\s*['"][^'"]*\bsubs-row\b/i.test(row[1] ?? '')) continue;
    const cells = [...(row[2] ?? '').matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(match => match[1] ?? '');
    const titleCell = cells.find(cell => /c2field|act=download/i.test(cell)) ?? '';
    const anchor = titleCell.match(/<a\b([^>]*)>([\s\S]*?)<\/a>/i);
    const href = anchor?.[1]?.match(/\bhref\s*=\s*['"]([^'"]+)['"]/i)?.[1];
    const titleText = stripTags(titleCell); const title = titleText.match(/^(.+?)\s*\(\d{4}\)/)?.[1]?.trim() ?? stripTags(anchor?.[2] ?? '');
    const lang = language(stripTags(cells[5] ?? ''));
    if (!href || !title || !lang || !isTitleMatch(context, title)) continue;
    const foundEpisode = episodeSearchMatch(titleText, episode);
    if (foundEpisode != null && foundEpisode !== episode) continue;
    const parsed = new URL(absolutize(`${SUBSSABBZ_BASE}/`, href));
    parsed.searchParams.delete('s');
    const filename = stripTags(anchor?.[2] ?? '') || titleText;
    output.push({ title, download: parsed.href, language: lang, filename, releaseGroup: filename.match(/\[([^\]]+)\]/)?.[1] ?? null });
  }
  return output;
}

function formBody(fields: Record<string, string | number>): string { return new URLSearchParams(Object.entries(fields).map(([key, value]) => [key, String(value)])).toString(); }

export class SubsunacsProvider extends BaseProvider {
  readonly id = 'subsunacs';
  async search(animeIds: SubtitleAnimeIds, season: number | null, episode: number): Promise<SubtitleCandidate[]> {
    const queryTitle = `${animeIds.title} ${String(season ?? 1).padStart(2, '0')} ${String(episode).padStart(2, '0')}`.normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^\x00-\x7f]/g, '').replaceAll("'", '');
    const data = formBody({ m: queryTitle, l: 0, c: '', y: '', action: '   Търси   ', a: '', d: '', u: '', g: '', t: '', imdbcheck: 1 });
    const response = await requestText(SUBSUNACS_SEARCH, { provider: this.id, method: 'POST', body: data, cache: true, referer: `${SUBSUNACS_BASE}/index.php`, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    return parseSubsunacs(response.text, animeIds, episode).map(item => this.candidate(animeIds, { providerId: stableId(this.id, item.page), episodeNumber: episode, language: item.language, releaseGroup: item.releaseGroup, format: null, sourceUrl: item.page, attribution: 'SubsUnacs', fetchable: true, providerRef: { downloadUrl: item.download, filename: item.filename } }));
  }
  async fetch(row: SubtitleCandidate): Promise<DownloadedSubtitle> {
    const page = row.sourceUrl ?? String(row.providerRef?.downloadUrl ?? '');
    let target = String(row.providerRef?.downloadUrl ?? `${page.replace(/\/$/, '')}/!`);
    let response = await requestBytes(target, { provider: this.id, referer: SUBSUNACS_SEARCH });
    if (response.bytes.length < 20) throw new Error('SubsUnacs returned an empty subtitle response');
    if (/^\s*</.test(new TextDecoder().decode(response.bytes.subarray(0, 128)))) {
      const html = new TextDecoder().decode(response.bytes);
      const entries = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)].flatMap(match => {
        const href = match[1]?.match(/\bhref\s*=\s*['"]([^'"]*getentry\.php[^'"]*)['"]/i)?.[1]; const filename = stripTags(match[2] ?? '');
        return href && /\.(srt|ass|ssa|vtt)$/i.test(filename) ? [{ url: absolutize(target, href), filename }] : [];
      });
      if (!entries.length) throw new Error('SubsUnacs page did not expose subtitle entries');
      const chosen = entries.find(entry => entry.filename === row.providerRef?.filename) ?? entries.find(entry => episodeInName(entry.filename) === row.episodeNumber) ?? entries[0]!;
      target = chosen.url;
      response = await requestBytes(target, { provider: this.id, referer: String(row.providerRef?.downloadUrl ?? page) });
    }
    const archive = zipSubtitleEntries(response.bytes);
    const selected = archive.find(entry => episodeInName(entry.name) === row.episodeNumber) ?? archive[0];
    const bytes = selected?.bytes ?? response.bytes;
    const fileName = selected?.name ?? String(row.providerRef?.filename ?? page);
    const format = contentTypeFormat(bytes, fileName, response.headers.get('content-type') ?? '');
    return { body: decodeSubtitle(bytes), format, language: row.language };
  }
}

export class SubsSabBzProvider extends BaseProvider {
  readonly id = 'subssabbz';
  async search(animeIds: SubtitleAnimeIds, season: number | null, episode: number): Promise<SubtitleCandidate[]> {
    const title = animeIds.title.normalize('NFKD').replace(/\p{M}/gu, '').replaceAll("'", '');
    const response = await requestText(SUBSSABBZ_SEARCH, { provider: this.id, method: 'POST', body: formBody({ act: 'search', movie: title, 'select-language': '2', upldr: '', yr: '', release: '' }), cache: true, retry403: true, referer: `${SUBSSABBZ_BASE}/`, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    return parseSubssabbz(response.text, animeIds, episode).map(item => this.candidate(animeIds, { providerId: stableId(this.id, item.download), episodeNumber: episode, language: item.language, releaseGroup: item.releaseGroup, sourceUrl: item.download, format: null, attribution: 'subs.sab.bz', fetchable: true, providerRef: { filename: item.filename, season: season ?? 1 } }));
  }
  async fetch(row: SubtitleCandidate): Promise<DownloadedSubtitle> {
    if (!row.sourceUrl) throw new Error('subs.sab.bz result has no download URL');
    const response = await requestBytes(row.sourceUrl, { provider: this.id, referer: SUBSSABBZ_SEARCH, timeoutMs: 30000, retry403: true });
    const archive = zipSubtitleEntries(response.bytes);
    const selected = archive.find(entry => episodeInName(entry.name) === row.episodeNumber) ?? archive[0];
    const bytes = selected?.bytes ?? response.bytes;
    const fileName = selected?.name ?? String(row.providerRef?.filename ?? row.sourceUrl);
    if (/^\s*</.test(new TextDecoder().decode(bytes.subarray(0, 128)))) throw new Error('subs.sab.bz download returned HTML instead of a subtitle');
    return { body: decodeSubtitle(bytes), format: contentTypeFormat(bytes, fileName, response.headers.get('content-type') ?? ''), language: row.language };
  }
}

export function parseAniMaFeedPage(text: string): AniMaEntry[] {
  const feed = JSON.parse(text) as { feed?: { entry?: Array<{ title?: { $t?: string }; link?: Array<{ rel?: string; href?: string }>; category?: Array<{ term?: string }> }> } };
  return (feed.feed?.entry ?? []).flatMap(entry => {
    const title = entry.title?.$t?.trim() ?? '';
    const url = entry.link?.find(link => link.rel === 'alternate')?.href ?? '';
    if (!title || !url) return [];
    const aliases = [...title.split(/\s+\/\s+/), ...(entry.category ?? []).map(category => category.term ?? '').filter(value => value.length > 3 && !/^\d{4}$/.test(value))].map(value => value.trim()).filter(Boolean);
    return [{ title, aliases: [...new Set(aliases)], url, providerId: new URL(url).pathname.split('/').filter(Boolean).at(-1) ?? stableId('anima-bg', url) }];
  });
}

export async function crawlAniMaCatalog(force = false, request: typeof requestText = requestText): Promise<AniMaEntry[]> {
  if (!force && aniMaEntries && Date.now() - aniMaFetchedAt < 7 * 24 * 60 * 60_000) return aniMaEntries;
  const entries: AniMaEntry[] = [];
  let start = 1;
  for (let page = 0; page < 20; page++) {
    const url = `https://anima-pr.blogspot.com/feeds/posts/default?${new URLSearchParams({ alt: 'json', 'max-results': '500', 'start-index': String(start) })}`;
    const response = await request(url, { provider: 'anima-bg-fansubs', cache: true, timeoutMs: 20000 });
    const found = parseAniMaFeedPage(response.text);
    if (!found.length) break;
    entries.push(...found);
    start += found.length;
  }
  aniMaEntries = entries;
  aniMaFetchedAt = Date.now();
  return entries;
}

export async function crawlAnimeBgCatalog(force = false): Promise<Array<{ title: string; aliases: string[]; url: string; providerId: string }>> {
  return (await crawlAniMaCatalog(force)).map(entry => ({ ...entry }));
}

export class AniMaBgCatalogProvider extends BaseProvider {
  readonly id = 'anima-bg-fansubs';
  async search(animeIds: SubtitleAnimeIds, _season: number | null, _episode: number): Promise<SubtitleCandidate[]> {
    const entries = await crawlAniMaCatalog();
    return entries.filter(entry => isTitleMatch(animeIds, entry.title) || entry.aliases.some(alias => isTitleMatch(animeIds, alias))).map(entry => this.candidate(animeIds, { providerId: entry.providerId, episodeNumber: 0, language: 'bg', sourceUrl: entry.url, attribution: `AniMa BG Fansubs — ${entry.title}`, verified: false, catalogOnly: true, fetchable: false, format: null }));
  }
  async fetch(): Promise<DownloadedSubtitle> { throw new Error('AniMa BG Fansubs is a catalog-only source and does not provide subtitle files'); }
}

const ARCHIVE_OWNER = 'Subtitle-Archival-Initiative';
const ARCHIVE_REPO = 'anime-subtitle-archival';
const ARCHIVE_BRANCH_URL = `https://api.github.com/repos/${ARCHIVE_OWNER}/${ARCHIVE_REPO}`;
const ARCHIVE_TREE_URL = (branch: string) => `https://api.github.com/repos/${ARCHIVE_OWNER}/${ARCHIVE_REPO}/git/trees/${encodeURIComponent(branch)}?recursive=1`;
function buildArchiveRows(treeText: string, branch: string): SubtitleCandidate[] {
  const tree = JSON.parse(treeText) as { tree?: Array<{ path: string; type: string }> };
  animeArchiveBranch = branch;
  return (tree.tree ?? []).flatMap(entry => {
    if (entry.type !== 'blob' || !/\.(srt|ass|ssa|vtt)$/i.test(entry.path)) return [];
    const parts = entry.path.split('/'); const root = parts[0] ?? '';
    const idMatch = root.match(/\[a(\d+)\]/i);
    if (!idMatch) return [];
    const animeTitle = root.replace(/\s*\[a\d+\]\s*$/i, '').trim();
    const group = parts.length > 2 ? parts[1] : null;
    const languageHint = language(entry.path) || 'en';
    const episode = episodeInName(entry.path);
    if (episode == null) return [];
    const rawUrl = `https://raw.githubusercontent.com/${ARCHIVE_OWNER}/${ARCHIVE_REPO}/${branch}/${entry.path.split('/').map(encodeURIComponent).join('/')}`;
    const providerId = entry.path;
    return [{ animeId: `archive:${idMatch[1]}`, anidbId: idMatch[1]!, episodeNumber: episode, language: languageHint, provider: 'anime-subtitle-archival', providerId, releaseGroup: group, format: entry.path.split('.').at(-1)?.toLowerCase() ?? null, sourceUrl: rawUrl, attribution: `Anime Subtitle Archival — ${animeTitle}${group ? ` / ${group}` : ''}`, qualityScore: 0, verified: false, catalogOnly: false, fetchable: true, filename: parts.at(-1), providerRef: { animeTitle, path: entry.path } }];
  });
}

async function getArchiveRows(force = false): Promise<SubtitleCandidate[]> {
  if (!force && animeArchiveRows) return animeArchiveRows;
  let branch = 'main';
  let treeResponse = await requestText(ARCHIVE_TREE_URL(branch), { provider: 'anime-subtitle-archival', headers: { Accept: 'application/vnd.github+json' }, cache: true, timeoutMs: 30000, allowStatuses: [404] });
  if (treeResponse.status === 404) {
    const repo = await requestText(ARCHIVE_BRANCH_URL, { provider: 'anime-subtitle-archival', headers: { Accept: 'application/vnd.github+json' }, cache: true });
    const metadata = JSON.parse(repo.text) as { default_branch?: string };
    branch = metadata.default_branch ?? 'English';
    treeResponse = await requestText(ARCHIVE_TREE_URL(branch), { provider: 'anime-subtitle-archival', headers: { Accept: 'application/vnd.github+json' }, cache: true, timeoutMs: 30000 });
  }
  animeArchiveRows = buildArchiveRows(treeResponse.text, branch);
  animeArchiveByAniDb = new Map();
  animeArchiveByTitle = new Map();
  for (const row of animeArchiveRows) {
    const id = row.anidbId ?? '';
    const title = normalizeSubtitleTitle(String(row.providerRef?.animeTitle ?? ''));
    if (id) { const matches = animeArchiveByAniDb.get(id); if (matches) matches.push(row); else animeArchiveByAniDb.set(id, [row]); }
    if (title) { const matches = animeArchiveByTitle.get(title); if (matches) matches.push(row); else animeArchiveByTitle.set(title, [row]); }
  }
  return animeArchiveRows;
}

export class AnimeSubtitleArchivalProvider extends BaseProvider {
  readonly id = 'anime-subtitle-archival';
  async search(animeIds: SubtitleAnimeIds, _season: number | null, episode: number): Promise<SubtitleCandidate[]> {
    await getArchiveRows();
    const rows = animeIds.anidbId
      ? animeArchiveByAniDb.get(animeIds.anidbId) ?? []
      : [...new Set([animeIds.title, ...(animeIds.aliases ?? [])].flatMap(title => animeArchiveByTitle.get(normalizeSubtitleTitle(title)) ?? []))];
    return rows.filter(row => row.episodeNumber === episode).map(row => ({ ...row, animeId: animeIds.animeId, imdbId: animeIds.imdbId ?? null, seasonNumber: animeIds.season ?? null }));
  }
  async fetch(row: SubtitleCandidate): Promise<DownloadedSubtitle> {
    if (!row.sourceUrl) throw new Error('Archive subtitle has no raw file URL');
    const response = await requestBytes(row.sourceUrl, { provider: this.id, headers: { Accept: 'text/plain' } });
    const format = contentTypeFormat(response.bytes, row.filename ?? row.sourceUrl, response.headers.get('content-type') ?? '');
    return { body: decodeSubtitle(response.bytes), format, language: row.language };
  }
}

export const subtitleIndexProviders: SubtitleIndexProvider[] = [
  new OpenSubtitlesProvider(),
  new SubsunacsProvider(),
  new SubsSabBzProvider(),
  new AnimeSubtitleArchivalProvider(),
  new AniMaBgCatalogProvider(),
];

export function providerForSubtitleIndex(id: string): SubtitleIndexProvider | undefined { return subtitleIndexProviders.find(provider => provider.id === id); }
