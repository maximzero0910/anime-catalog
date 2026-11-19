export type SourceLanguage = 'en' | 'ja';

export interface TranslationCue {
  id: string;
  text: string;
  speaker: string | null;
}
