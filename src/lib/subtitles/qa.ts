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
    const spokenText = output.replace(/\{[^}]*\}|<[^>]+>/g, '').trim();
    if (/[\p{Script=Latin}]/u.test(spokenText)) {
      const latinWords = spokenText.match(/\b[A-Za-z][A-Za-z'-]*\b/g) ?? [];
      const retainedProperName = latinWords.length > 0 && latinWords.length <= 2 && latinWords.every(word => /^[A-Z][a-z]+(?:['-][A-Z]?[a-z]+)*$/.test(word));
      if (!retainedProperName) issues.push(`untranslated-latin-fragment:${original.id}`);
    }
    if (/^[A-Za-z\p{P}\p{N}\s]+$/u.test(spokenText) && /\p{L}/u.test(original.originalText) && !/^(?:\[.*\]|\(.*\)|♪.*♪)$/u.test(original.originalText.trim())) untranslated++;
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
