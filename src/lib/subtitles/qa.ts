import type { NormalizedSubtitle } from './normalize';

export interface QAResult { valid: boolean; score: number; issues: string[]; }
function sameTags(source: string, translated: string): boolean {
  const collect = (value: string) => [...value.matchAll(/\{[^}]*\}|<[^>]+>/g)].map(match => match[0]);
  return JSON.stringify(collect(source)) === JSON.stringify(collect(translated));
}
function matchesGlossaryTerm(output: string, target: string): boolean {
  const normalizedOutput = output.toLocaleLowerCase('bg-BG');
  const normalizedTarget = target.toLocaleLowerCase('bg-BG').trim();
  if (normalizedOutput.includes(normalizedTarget)) return true;
  const escapedWords = normalizedTarget.split(/\s+/).filter(Boolean).map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!escapedWords.length) return true;
  const inflectedPhrase = escapedWords.map(word => `${word}(?:[а-я]{1,3})?`).join('\\s+');
  return new RegExp(`(?:^|[^а-я])${inflectedPhrase}(?=$|[^а-я])`, 'u').test(normalizedOutput);
}
const commonEnglishWords = new Set(`a an and are as at be been believe break but by bye can cant close come could did die do does dont fall fight for from get go going got had has have hate he help her here hers him his how hello hi if in into is it its leave let like listen live look love make me mine move my need no not of on open or our ours please protect run safe save say she so sorry stay stop take tell than that the their theirs them then there these they think this those to too try turn us wait want was we were what when where which who will with would yes you your yours`.split(' '));
const retainedLatinExpressions = new Set(`arigatou arigato ohayou konnichiwa konbanwa itadakimasu gochisousama nani baka senpai sempai sensei sama kun chan san dono sama`.split(' '));

function latinRuns(value: string): string[] {
  return value.match(/[\p{Script=Latin}\p{N}][\p{Script=Latin}\p{N}'’.-]*(?:[ \t]+[\p{Script=Latin}\p{N}][\p{Script=Latin}\p{N}'’.-]*)*/gu) ?? [];
}

function isRetainedLatinName(run: string, original: string, glossary: Array<{ source: string; target: string }>): boolean {
  const trimmed = run.trim().replace(/^[\p{P}\s]+|[\p{P}\s]+$/gu, '');
  if (!trimmed) return true;
  const normalized = trimmed.toLocaleLowerCase('en-US').replace(/[’]/g, "'").replace(/\s+/g, ' ');
  const source = original.toLocaleLowerCase('en-US').replace(/[’]/g, "'").replace(/\s+/g, ' ');
  const sourceHasNonLatinScript = /[^\p{Script=Latin}\p{P}\p{N}\s]/u.test(original);
  if ((sourceHasNonLatinScript && source.includes(normalized)) || glossary.some(term => term.target && term.target.toLocaleLowerCase('en-US').replace(/[’]/g, "'").includes(normalized))) return true;
  if (/^(?:[A-Z]\.){2,}$/.test(trimmed) || /^(?:[A-Z]{2,}[A-Z0-9]*|[A-Z0-9]*\d[A-Za-z0-9-]*)$/.test(trimmed)) return true;

  const words = trimmed.match(/[\p{Script=Latin}\p{N}]+(?:['’.-][\p{Script=Latin}\p{N}]+)*/gu) ?? [];
  if (words.length === 1) {
    const word = words[0]!;
    const lower = word.toLocaleLowerCase('en-US').replace(/['’.-]/g, '');
    if (retainedLatinExpressions.has(lower)) return true;
    const looksLikeName = /^[A-Z][a-z]+(?:['’][A-Za-z]+)*(?:-[A-Z]?[a-z]+)*$/.test(word)
      || /^[A-Z]?[a-z]+[A-Z][A-Za-z0-9]*$/.test(word)
      || /^[A-Z]{2,}$/.test(word);
    return looksLikeName && !commonEnglishWords.has(lower);
  }
  if (words.length > 5) return false;
  const allCapsPhrase = words.length > 1 && words.every(word => /^[A-Z0-9]+$/.test(word));
  if (allCapsPhrase) return false;
  const entityWords = words.filter(word => {
    const lower = word.toLocaleLowerCase('en-US').replace(/['’.-]/g, '');
    if (commonEnglishWords.has(lower)) return false;
    return /^[A-Z][a-z]+(?:['’][A-Za-z]+)*(?:-[A-Z]?[a-z]+)*$/.test(word)
      || /^[A-Z]?[a-z]+[A-Z][A-Za-z0-9]*$/.test(word)
      || (/^[A-Z]{2,}$/.test(word) && words.length === 1)
      || /\d/.test(word);
  });
  // A short, consistently capitalized run is a plausible character, group, brand, or title.
  // Requiring two entity-like words avoids accepting sentence-case English such as "I Love You".
  return entityWords.length >= 2;
}

export function validateTranslation(source: NormalizedSubtitle, translated: NormalizedSubtitle, glossary: Array<{ source: string; target: string }>): QAResult {
  const issues: string[] = [];
  if (source.cues.length !== translated.cues.length) issues.push('cue-count-mismatch');
  const sourceIds = source.cues.map(cue => cue.id); const translatedIds = translated.cues.map(cue => cue.id);
  if (new Set(translatedIds).size !== translatedIds.length) issues.push('duplicate-cue-id');
  if (sourceIds.some((id, index) => translatedIds[index] !== id)) issues.push('cue-id-order-mismatch');
  let untranslated = 0; let suspiciousLength = 0;
  for (let index = 0; index < source.cues.length; index++) {
    const original = source.cues[index]!; const result = translated.cues[index];
    if (!result) continue;
    if (result.start !== original.start || result.end !== original.end) issues.push(`timestamp-drift:${original.id}`);
    const output = result.originalText.trim();
    if (!output) { issues.push(`empty-translation:${original.id}`); continue; }
    // ASS \N/\n/\h are layout controls, not Latin dialogue. Keep them in the cue for
    // serialization and tag validation, but exclude them from language checks.
    const spokenText = output.replace(/\{[^}]*\}|<[^>]+>/g, '').replace(/\\[Nnh]/g, ' ').trim();
    const runs = latinRuns(spokenText);
    const untranslatedRuns = runs.filter(run => !isRetainedLatinName(run, original.originalText, glossary));
    if (untranslatedRuns.length) issues.push(`untranslated-latin-fragment:${original.id}`);
    const latinOnlyDialogue = /^[\p{Script=Latin}\p{P}\p{N}\s]+$/u.test(spokenText)
      && /\p{L}/u.test(original.originalText)
      && !/^(?:\[.*\]|\(.*\)|♪.*♪)$/u.test(original.originalText.trim());
    if (latinOnlyDialogue && (!runs.length || untranslatedRuns.length > 0)) untranslated++;
    const ratio = output.length / Math.max(1, original.originalText.length);
    if (ratio < 0.12 || ratio > 4) suspiciousLength++;
    if (!sameTags(original.originalText, output)) issues.push(`formatting-changed:${original.id}`);
    for (const term of glossary) if (term.source && term.target && original.originalText.toLowerCase().includes(term.source.toLowerCase()) && !matchesGlossaryTerm(output, term.target)) issues.push(`glossary-violation:${original.id}:${term.source}`);
  }
  if (untranslated > Math.max(2, Math.ceil(source.cues.length * 0.08))) issues.push(`untranslated-lines:${untranslated}`);
  if (suspiciousLength > Math.max(1, Math.ceil(source.cues.length * 0.05))) issues.push(`implausible-length-ratio:${suspiciousLength}`);
  const score = Math.max(0, Math.min(1, 1 - issues.length / Math.max(5, source.cues.length * 0.12)));
  const latinFragmentCount = issues.filter(issue => issue.startsWith('untranslated-latin-fragment:')).length;
  const latinFragmentRatio = latinFragmentCount / Math.max(1, source.cues.length);
  // DECISION: retain per-cue warnings, but don't discard an otherwise sound episode for a few borrowed names or phrases; provider-level Cyrillic checks and the existing episode score still reject predominantly untranslated output.
  const hasHardFailure = issues.some(issue => !issue.startsWith('untranslated-latin-fragment:'));
  return { valid: !hasHardFailure && latinFragmentRatio <= 0.02, score, issues };
}
