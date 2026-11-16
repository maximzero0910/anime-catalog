import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { getTitles, type Title } from '../db';
import { saveTelegramMatch, telegramAliases, type TelegramMessageRow } from './storage';

const catalog = new Database(resolve(process.env.CATALOG_DB_PATH ?? 'data/catalog.db'), { timeout: 5000 });
const normalize = (value: string) => value.toLocaleLowerCase().normalize('NFKD').replace(/\p{Diacritic}/gu, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const normalizeStrict = (value: string) => value.toLocaleLowerCase().normalize('NFKD').replace(/\p{Diacritic}/gu, '').replace(/[.,:;_\-–—△？?]+/gu, ' ').replace(/\s+/g, ' ').trim();
interface ParsedEpisode { episode: number; season: number | null; explicit: boolean; titleText: string; }
export interface ParsedTelegramMedia { episode: number | null; season: number | null; explicit: boolean; titleNames: string[]; compilation: boolean; }
const stripReleaseNoise = (value: string) => value
  .replace(/\.(?:mp4|mkv|avi|webm|mov)$/i, ' ')
  .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
  .replace(/\b(?:anima(?:bg|inc)?|bgsubs?|bg|bul|hardsub|softsub|720p|1080p|2160p|web[- ]?dl|x26[45]|h26[45])\b/giu, ' ')
  .replace(/[._]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

/** Extract one episode marker from either the caption or file name without mistaking a pack for one episode. */
export function parseTelegramMedia(filename: string, caption: string, durationSeconds: number | null = null): ParsedTelegramMedia {
  const inputs = [filename, caption].filter(Boolean);
  const parsed: Array<{ season: number | null; episode: number; title: string; input: string }> = [];
  let compilation = false;
  let filenameHasRange = false;
  for (const input of inputs) {
    const text = stripReleaseNoise(input);
    let match: RegExpMatchArray | null;
    const sequelEpisode = text.match(/(?:^|\s)([2-9])\s*[-_. ]+\s*0*(\d{2,3})(?=\s*(?:end|bg|v\d+|$))/iu);
    if (sequelEpisode) {
      const prefix = text.slice(0, sequelEpisode.index).trim();
      if (prefix && !/(?:episode|episod|\bep\b|епизод|\bеп\b)$/iu.test(prefix)) {
        const title = prefix.replace(/[-_.\s]+$/g, '').trim();
        if (title) {
          parsed.push({ season: Number(sequelEpisode[1]), episode: Number(sequelEpisode[2]), title, input });
          continue;
        }
      }
    }
    const hasRange = /(?:^|[^\p{L}\p{N}])(?:s\s*\d{1,2}\s*)?(?:e|ep|episode|еп|епизод)\s*0*\d{1,3}\s*[-–]\s*0*\d{1,3}(?=\s*(?:end|bg|v\d+|$|[^\p{L}\p{N}]))/iu.test(text)
      || /(?:^|\s)\d{1,3}\s*[-–]\s*\d{1,3}(?=\s*(?:end|bg|v\d+|$|[^\p{L}\p{N}]))/iu.test(text);
    if (hasRange) {
      compilation = true;
      if (input === filename) filenameHasRange = true;
      continue;
    }
    match = text.match(/[sс]\s*(\d{1,2})\s*[eе]\s*0*(\d{1,3})(?:\s*(?:end|v\d+|bg))*(?:$|[^\p{L}\p{N}])/iu)
      ?? text.match(/(?:^|[^\p{L}\p{N}])[sс]\s*(\d{1,2})\s*(?:sp|ova)\s*0*(\d{1,3})(?:$|[^\p{L}\p{N}])/iu)
      ?? text.match(/(?:^|[^\p{L}\p{N}])[sс](\d{1,2})(\d{2})(?=\D|$)/iu)
      ?? text.match(/(?:^|[^\p{L}\p{N}])(\d{1,2})\s*[xх×]\s*0*(\d{1,3})(?:$|[^\p{L}\p{N}])/iu);
    if (match) {
      let season = Number(match[1]);
      const episode = Number(match[2]);
      let title = text.slice(0, match.index).replace(/[-_.\s]+$/g, '').trim();
      const trailingSeason = title.match(/(?:^|\s)[sс]\s*0*(\d{1,2})$/iu);
      if (trailingSeason && season < 1) season = Number(trailingSeason[1]);
      if (trailingSeason) title = title.slice(0, trailingSeason.index).trim();
      if (title && episode > 0) parsed.push({ season, episode, title, input });
      continue;
    }
    match = text.match(/(?:^|[^\p{L}\p{N}])(?:episode|ep|episod|епизод|еп)\s*[-_.#:]?\s*0*(\d{1,3})(?:\.\d)?(?:\s*(?:end|v\d+|bg))*(?:$|[^\p{L}\p{N}])/iu)
      ?? text.match(/(?:^|[-\s])0*(\d{1,3})(?=\s*(?:(?:end|bg|v\d+))*(?:$|[^\p{L}\p{N}]))/iu);
    if (match) {
      const episode = Number(match[1]);
      let title = text.slice(0, match.index).replace(/[-_.\s]+$/g, '').trim();
      const trailingSeason = title.match(/(?:^|\s)[sс]\s*0*(\d{1,2})$/iu);
      const numberedSeason = title.match(/(?:^|\s)([2-9])$/u);
      const romanSeason = title.match(/(?:^|\s)(ii|iii)$/iu);
      const season = trailingSeason ? Number(trailingSeason[1]) : numberedSeason ? Number(numberedSeason[1]) : romanSeason ? romanSeason[1]!.toLowerCase() === 'ii' ? 2 : 3 : null;
      if (trailingSeason) title = title.slice(0, trailingSeason.index).trim();
      else if (numberedSeason) title = title.slice(0, numberedSeason.index).trim();
      else if (romanSeason) title = title.slice(0, romanSeason.index).trim();
      if (title && episode > 0) parsed.push({ season, episode, title, input });
    }
  }
  const names = [...new Set(parsed.map(item => item.title).filter(name => name.length > 1))];
  const chosen = parsed.find(item => item.input === filename) ?? parsed[0];
  if (chosen) return { episode: filenameHasRange || (compilation && (durationSeconds ?? 0) > 2400) ? null : chosen.episode, season: chosen.season, explicit: true, titleNames: names, compilation };

  const mediaTitles = inputs.map(stripReleaseNoise).map(name => name
    .replace(/🎬|🎞|📅/gu, ' ')
    .replace(/(?:излъчвано|излъчване|превод).*$/iu, ' ')
    .replace(/\b(?:19|20)\d{2}\b/gu, ' ')
    .replace(/(?:филмът|филма|филм|movie|film|ova|special|\bsp\b)/giu, ' ')
    .replace(/\s+/g, ' ').replace(/^[-\s]+|[-\s]+$/g, '').trim()).filter(name => name.length > 1);
  const isStandalone = /(?:movie|film|филм\p{L}*|ova|special|\bsp\b)/iu.test(inputs.join(' '));
  const standaloneEpisode = isStandalone && !filenameHasRange && !(compilation && (durationSeconds ?? 0) > 2400);
  return { episode: standaloneEpisode ? 1 : null, season: null, explicit: standaloneEpisode, titleNames: [...new Set(mediaTitles)], compilation };
}

export function parseTelegramEpisode(value: string): ParsedEpisode | null {
  const text = value.replace(/\.[a-z0-9]{2,5}(?:\s|$)/ig, ' ').replace(/\[[^\]]*\]|\([^)]*\)/g, ' ');
  if (/(?:episode|episod|ep|епизод|еп)\s*[-_.#:]?\s*\d{1,3}\s*[-–]\s*\d{1,3}\b/i.test(text) || /(?:^|\s)\d{1,3}\s*[-–]\s*\d{1,3}(?:\s|$)/.test(text)) return null;
  let match = text.match(/(?:^|[^\p{L}\p{N}])[sс](?:eason\s*)?(\d{1,2})(?:\s*[-_. ]?(?:e|е)(?:p|п)?(?:isode)?\s*[-_.#:]?|\s+(?:episode|ep|episod|епизод|еп)\s*[-_.#:]?)\s*(\d{1,3})(?:$|[^\p{L}\p{N}])/iu) ?? text.match(/(?:^|[^\p{L}\p{N}])(\d{1,2})\s*[xх×]\s*(\d{1,3})(?:$|[^\p{L}\p{N}])/iu);
  if (match) return { season: Number(match[1]), episode: Number(match[2]), explicit: true, titleText: text.slice(0, match.index).replace(/[-_.]+$/g, ' ').trim() };
  match = text.match(/(?:^|[^\p{L}\p{N}])(?:episode|ep|episod|епизод|еп)\s*[-_.#:]?\s*(\d{1,3})(?:\.\d)?(?:$|[^\p{L}\p{N}])/iu);
  if (match) return { season: null, episode: Number(match[1]), explicit: true, titleText: text.slice(0, match.index).replace(/[-_.]+$/g, ' ').trim() };
  match = text.match(/(?:^|\s)[-_. ](\d{1,3})(?:\s|$)/);
  return match ? { season: null, episode: Number(match[1]), explicit: false, titleText: text.slice(0, match.index).trim() } : null;
}
function titleNames(title: Title, aliases: Map<number, string[]>): string[] {
  return [...new Set([title.english, title.romaji, title.native, title.title_bg, ...(aliases.get(title.id) ?? [])].filter((name): name is string => Boolean(name && name.trim())).map(name => name.trim()))];
}
function catalogSeason(title: Title): number | null {
  for (const name of [title.romaji, title.english, title.native]) {
    if (!name) continue;
    const normalized = normalize(name);
    const match = normalized.match(/(?:season|series)\s+(\d{1,2})|\b(\d{1,2})(?:st|nd|rd|th)\s+season\b|第\s*(\d{1,2})\s*期|\s(\d{1,2})$|\s(ii|iii)$/);
    if (match) return Number(match[1] ?? match[2] ?? match[3] ?? match[4] ?? (match[5] === 'ii' ? 2 : match[5] === 'iii' ? 3 : 0)) || null;
  }
  return null;
}
export function scoreTelegramTitle(names: string[], text: string): { score: number; matched: string | null } {
  const normalizedText = normalize(text);
  let best = { score: 0, matched: null as string | null };
  for (const name of names) {
    const normalizedName = normalize(name);
    if (!normalizedName) continue;
    const strictName = normalizeStrict(name);
    const strictText = normalizeStrict(text);
    const exact = strictText === strictName;
    const contains = normalizedText.includes(normalizedName);
    const titleIsAlias = normalizedName.startsWith(`${normalizedText} `);
    const punctuationEquivalent = normalizedText === normalizedName;
    const tokens = normalizedName.split(' ').filter(token => token.length > 1);
    const overlap = tokens.length ? tokens.filter(token => normalizedText.includes(token)).length / tokens.length : 0;
    const shorter = Math.min(normalizedName.length, normalizedText.length);
    let distance = 0;
    if (shorter >= 6 && Math.abs(normalizedName.length - normalizedText.length) <= 3) {
      let previous = Array.from({ length: normalizedText.length + 1 }, (_, index) => index);
      for (let i = 1; i <= normalizedName.length; i++) {
        const current = [i];
        for (let j = 1; j <= normalizedText.length; j++) current[j] = Math.min(current[j - 1]! + 1, previous[j]! + 1, previous[j - 1]! + (normalizedName[i - 1] === normalizedText[j - 1] ? 0 : 1));
        previous = current;
      }
      distance = previous[normalizedText.length]!;
    }
    const similarity = shorter >= 6 && Math.abs(normalizedName.length - normalizedText.length) <= 3
      ? 1 - distance / Math.max(normalizedName.length, normalizedText.length)
      : 0;
    const score = exact ? 0.94 : titleIsAlias ? 0.9 : punctuationEquivalent ? 0.9 : contains ? 0.76 : similarity >= 0.9 ? 0.9 : overlap >= 0.8 ? 0.72 * overlap : 0;
    if (score > best.score) best = { score, matched: name };
  }
  return best;
}
function catalogDuration(titleId: number, episode: number): number | null {
  const item = catalog.prepare('SELECT duration FROM episodes WHERE title_id=? AND number=?').get(titleId, episode) as { duration: number | null } | undefined;
  return item?.duration ? item.duration * 1000 : null;
}
function ensureEpisode(titleId: number, episode: number, durationSeconds: number | null): void {
  catalog.prepare('INSERT INTO episodes(title_id,number,duration,filler) VALUES(?,?,?,0) ON CONFLICT(title_id,number) DO UPDATE SET duration=COALESCE(episodes.duration,excluded.duration)').run(titleId, episode, durationSeconds);
  catalog.prepare('UPDATE titles SET episodes=MAX(COALESCE(episodes,0),?) WHERE id=?').run(episode, titleId);
}
export function matchTelegramMessage(message: TelegramMessageRow): { status: string; animeId: number | null; episode: number | null; confidence: number; candidates: Array<{ animeId: number; title: string; score: number }> } {
  const parsed = parseTelegramMedia(message.filename, message.caption, message.duration_seconds);
  if (parsed.episode === null || parsed.episode < 1 || !parsed.titleNames.length) {
    saveTelegramMatch({ channel_id: message.channel_id, message_id: message.message_id, anime_id: null, episode_number: null, season_number: null, confidence: 0, status: 'UNMATCHED', reason: 'No reliable episode number in filename or caption', candidates: '[]', hardsub_language: 'bg', verified: 0, primary_match: 0 });
    return { status: 'UNMATCHED', animeId: null, episode: null, confidence: 0, candidates: [] };
  }
  const aliases = new Map<number, string[]>();
  for (const alias of telegramAliases()) aliases.set(alias.anime_id, [...(aliases.get(alias.anime_id) ?? []), alias.alias]);
  const titles = getTitles();
  const ranked = titles.map(title => {
    const possibleNames = titleNames(title, aliases);
    const lexical = parsed.titleNames.map(titlePart => scoreTelegramTitle(possibleNames, titlePart)).sort((a, b) => b.score - a.score)[0] ?? { score: 0, matched: null };
    const exactTitle = parsed.titleNames.some(titlePart => possibleNames.some(name => normalizeStrict(titlePart) === normalizeStrict(name)));
    const declaredSeason = catalogSeason(title);
    const seasonCompatible = parsed.season === null ? declaredSeason === null
      : parsed.season === 1 ? (declaredSeason === null || declaredSeason === 1)
        : declaredSeason === parsed.season;
    let confidence = !seasonCompatible ? 0 : !exactTitle ? Math.min(lexical.score, 0.82) : lexical.score;
    const expectedDuration = seasonCompatible && lexical.score > 0 ? catalogDuration(title.id, parsed.episode!) : null;
    if (expectedDuration && message.duration_seconds) {
      const drift = Math.abs(expectedDuration - message.duration_seconds * 1000);
      if (drift > 2000) confidence = 0;
      else confidence = Math.min(0.99, confidence + (drift <= 1000 ? 0.06 : 0.03));
    }
    if (parsed.explicit && seasonCompatible && exactTitle && lexical.score >= 0.88) confidence = Math.max(confidence, 0.92);
    return { title, score: Math.round(confidence * 1000) / 1000, matched: lexical.matched };
  }).filter(candidate => candidate.score > 0).sort((a, b) => b.score - a.score);
  const candidates = ranked.slice(0, 5).map(item => ({ animeId: item.title.id, title: item.title.english ?? item.title.romaji ?? item.title.native ?? String(item.title.id), score: item.score }));
  const winner = ranked[0];
  const margin = winner ? winner.score - (ranked[1]?.score ?? 0) : 0;
  const status = winner && winner.score >= 0.92 && margin >= 0.12 ? 'MATCHED' : ranked.length ? 'AMBIGUOUS' : 'UNMATCHED';
  if (status === 'MATCHED' && winner) {
    ensureEpisode(winner.title.id, parsed.episode, message.duration_seconds);
    const already = catalog.prepare(`SELECT channel_id,message_id FROM telegram_episode_matches WHERE anime_id=? AND episode_number=? AND status='MATCHED' AND verified=1 AND primary_match=1 AND NOT(channel_id=? AND message_id=?)`).get(winner.title.id, parsed.episode, message.channel_id, message.message_id) as { channel_id: string; message_id: number } | undefined;
    const duplicate = Boolean(already);
    saveTelegramMatch({ channel_id: message.channel_id, message_id: message.message_id, anime_id: winner.title.id, episode_number: parsed.episode, season_number: parsed.season, confidence: winner.score, status: duplicate ? 'DUPLICATE' : 'MATCHED', reason: duplicate ? `Duplicate of Telegram post ${already!.message_id}` : `Matched title “${winner.matched}” and explicit episode marker`, candidates: JSON.stringify(candidates), hardsub_language: 'bg', verified: duplicate ? 0 : 1, primary_match: duplicate ? 0 : 1 });
    return { status: duplicate ? 'DUPLICATE' : status, animeId: winner.title.id, episode: parsed.episode, confidence: winner.score, candidates };
  }
  saveTelegramMatch({ channel_id: message.channel_id, message_id: message.message_id, anime_id: winner?.title.id ?? null, episode_number: parsed.episode, season_number: parsed.season, confidence: winner?.score ?? 0, status, reason: status === 'AMBIGUOUS' ? 'Low title confidence or competing catalog candidates; manual review required' : 'No catalog title matched the available names', candidates: JSON.stringify(candidates), hardsub_language: 'bg', verified: 0, primary_match: 0 });
  return { status, animeId: winner?.title.id ?? null, episode: parsed.episode, confidence: winner?.score ?? 0, candidates };
}

