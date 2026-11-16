import type { AniListAnime } from '../anilist';

export interface MatchTitleSet { romaji?: string | null; english?: string | null; native?: string | null; synonyms?: string[]; }

const romanToCyrillic: Array<[RegExp, string]> = [
  [/shch/g, 'щ'], [/sch/g, 'щ'], [/zh/g, 'ж'], [/kh/g, 'х'], [/ts/g, 'ц'], [/ch/g, 'ч'], [/sh/g, 'ш'], [/yu/g, 'ю'], [/ya/g, 'я'], [/yo/g, 'ё'], [/ye/g, 'е'], [/yi/g, 'и'], [/zh/g, 'ж'], [/j/g, 'дж'],
  [/a/g, 'а'], [/b/g, 'б'], [/v/g, 'в'], [/g/g, 'г'], [/d/g, 'д'], [/e/g, 'е'], [/z/g, 'з'], [/i/g, 'и'], [/y/g, 'й'], [/k/g, 'к'], [/l/g, 'л'], [/m/g, 'м'], [/n/g, 'н'], [/o/g, 'о'], [/p/g, 'п'], [/r/g, 'р'], [/s/g, 'с'], [/t/g, 'т'], [/u/g, 'у'], [/f/g, 'ф'], [/h/g, 'х'], [/c/g, 'к'], [/w/g, 'в'], [/x/g, 'кс'],
];

export function normalize(value: string): string {
  const protectedY = value.toLocaleLowerCase().replace(/й/g, '\uE000');
  const latin = protectedY.normalize('NFKD').replace(/\p{M}/gu, '').replace(/\uE000/g, 'й').replace(/\b(?:the|a|an)\b/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
  const roman = latin.replace(/[a-z]+/g, word => {
    let result = word;
    for (const [pattern, replacement] of romanToCyrillic) result = result.replace(pattern, replacement);
    return result;
  });
  const cyrillic: Record<string, string> = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sht', ъ: 'a', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };
  const transliterated = latin.replace(/[а-яёъыьэюя]/g, char => cyrillic[char] ?? char).replace(/sht/g, 'sht');
  return `${latin}|${roman}|${transliterated}`;
}

function editSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 100;
  const aa = a.split(' '); const bb = b.split(' ');
  const tokenScore = (x: string, y: string) => {
    const prev = Array.from({ length: y.length + 1 }, (_, i) => i);
    for (let i = 1; i <= x.length; i++) {
      let diagonal = prev[0]!; prev[0] = i;
      for (let j = 1; j <= y.length; j++) { const old = prev[j]!; prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diagonal + (x[i - 1] === y[j - 1] ? 0 : 1)); diagonal = old; }
    }
    return 100 * (1 - prev[y.length]! / Math.max(x.length, y.length));
  };
  const best = aa.map(token => Math.max(...bb.map(other => tokenScore(token, other))));
  const coverage = best.length ? best.reduce((sum, value) => sum + value, 0) / best.length : 0;
  const length = Math.min(a.length, b.length) / Math.max(a.length, b.length);
  return Math.round(coverage * 0.8 + length * 20);
}

export function scoreTitleMatch(titles: MatchTitleSet, candidate: string, aliases: string[] = []): number {
  const candidateForms = normalize(candidate).split('|');
  const forms = [titles.romaji, titles.english, titles.native, ...(titles.synonyms ?? []), ...aliases].filter((value): value is string => Boolean(value?.trim())).flatMap(value => normalize(value).split('|'));
  let best = 0;
  for (const a of forms) for (const b of candidateForms) best = Math.max(best, editSimilarity(a, b));
  return best;
}

export function animeTitleForms(anime: AniListAnime): string[] {
  return [...new Set([anime.title.romaji, anime.title.english, anime.title.native, ...anime.synonyms].filter((value): value is string => Boolean(value?.trim())))];
}

export function matchAtLeast85(titles: MatchTitleSet, candidate: string, aliases: string[] = []): boolean { return scoreTitleMatch(titles, candidate, aliases) >= 85; }
