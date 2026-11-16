import type { TranslationCue } from './inference';

const FORMATTING_TAG = /\{[^}]*\}|<[^>]+>/g;

export interface PreparedCue { cue: TranslationCue; tokens: string[]; }

export function prepareCueForTranslation(cue: TranslationCue): PreparedCue {
  const tokens: string[] = [];
  const text = cue.text.replace(FORMATTING_TAG, tag => {
    const token = `⟦SUBTITLE_TAG_${tokens.length}⟧`;
    tokens.push(tag);
    return token;
  });
  return { cue: { ...cue, text }, tokens };
}

export function restoreCueFormatting(originalText: string, translatedText: string): string {
  const tags = [...originalText.matchAll(FORMATTING_TAG)].map(match => match[0]);
  if (!tags.length) return translatedText;
  const tokens = tags.map((_, index) => `⟦SUBTITLE_TAG_${index}⟧`);
  const present = [...translatedText.matchAll(/⟦SUBTITLE_TAG_\d+⟧/g)].map(match => match[0]);
  if (JSON.stringify(present) !== JSON.stringify(tokens)) throw new Error('Model changed or omitted protected subtitle formatting markers');
  let restored = translatedText;
  for (let index = 0; index < tags.length; index++) restored = restored.replace(tokens[index]!, tags[index]!);
  return restored;
}
