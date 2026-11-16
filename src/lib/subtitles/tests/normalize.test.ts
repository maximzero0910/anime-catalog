import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSubtitle, serializeSubtitle } from '../normalize';
import { validateTranslation } from '../qa';
import { prepareCueForTranslation, restoreCueFormatting } from '../formatting';

test('SRT cue IDs normalize, output preserves every timestamp', () => {
  const source = parseSubtitle('1\n00:00:01,200 --> 00:00:02,400\nHello, friend!\n\n2\n00:00:03,000 --> 00:00:04,000\nLet us go.\n', 'srt');
  assert.equal(source.cues.length, 2);
  source.cues[0]!.translatedText = 'Здравей, приятелю!';
  source.cues[1]!.translatedText = 'Да тръгваме.';
  const serialized = serializeSubtitle(source);
  assert.match(serialized, /00:00:01,200 --> 00:00:02,400/);
  assert.match(serialized, /00:00:03,000 --> 00:00:04,000/);
  assert.match(serialized, /Здравей, приятелю!/);
  const reparsed = parseSubtitle(serialized, 'srt');
  assert.equal(reparsed.cues.length, 2);
  assert.deepEqual(reparsed.cues.map(cue => cue.id), source.cues.map(cue => cue.id));
});

test('ASS preserves header, dialogue fields and inline override tags', () => {
  const raw = '[Script Info]\nTitle: Example\nScriptType: v4.00+\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize\nStyle: Default,Arial,20\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:02.50,Default,Hero,0,0,0,,{\\i1}Hello!{\\i0}\\NWelcome.';
  const subtitle = parseSubtitle(raw, 'ass');
  assert.equal(subtitle.cues.length, 1);
  assert.equal(subtitle.cues[0]!.speaker, 'Hero');
  subtitle.cues[0]!.translatedText = '{\\i1}Здравей!{\\i0}\\NДобре дошъл.';
  const output = serializeSubtitle(subtitle);
  assert.match(output, /\[V4\+ Styles\]/);
  assert.match(output, /Format: Layer, Start, End/);
  assert.match(output, /Dialogue: 0,0:00:01\.00,0:00:02\.50,Default,Hero,0,0,0,,\{\\i1\}Здравей!\{\\i0\}\\NДобре дошъл\./);
});

test('translation formatting markers restore exact ASS and inline tags', () => {
  const original = '{\\i1}We <i>will </i>slay it{\\i0}';
  const prepared = prepareCueForTranslation({ id: 'tagged', text: original, speaker: null });
  assert.equal(prepared.cue.text, '⟦SUBTITLE_TAG_0⟧We ⟦SUBTITLE_TAG_1⟧will ⟦SUBTITLE_TAG_2⟧slay it⟦SUBTITLE_TAG_3⟧');
  assert.equal(restoreCueFormatting(original, '⟦SUBTITLE_TAG_0⟧Ще ⟦SUBTITLE_TAG_1⟧го убия⟦SUBTITLE_TAG_2⟧⟦SUBTITLE_TAG_3⟧'), '{\\i1}Ще <i>го убия</i>{\\i0}');
  assert.throws(() => restoreCueFormatting(original, 'Ще го убия'), /markers/);
});

test('WebVTT cues preserve IDs, speaker metadata and time values', () => {
  const subtitle = parseSubtitle('WEBVTT\n\nhero\n00:00:01.000 --> 00:00:02.500\n<v Hero>Hello!</v>\n', 'vtt');
  assert.equal(subtitle.cues.length, 1);
  assert.equal(subtitle.cues[0]!.id, 'hero');
  assert.equal(subtitle.cues[0]!.start, 1000);
  subtitle.cues[0]!.translatedText = '<v Hero>Здравей!</v>';
  const serialized = serializeSubtitle(subtitle);
  assert.match(serialized, /hero\n00:00:01\.000 --> 00:00:02\.500/);
  assert.equal(parseSubtitle(serialized, 'vtt').cues[0]!.id, 'hero');
});

test('QA rejects timestamp drift, duplicate IDs, empty and untranslated cues', () => {
  const source = parseSubtitle(['Hello!', 'Come on!', 'Wait!', 'Go!'].map((text, index) => `${index + 1}\n00:00:0${index + 1},000 --> 00:00:0${index + 2},000\n${text}`).join('\n\n'), 'srt');
  const translated = { ...source, cues: source.cues.map((cue, index) => ({ ...cue, id: index === 1 ? source.cues[0]!.id : cue.id, originalText: index === 1 ? '' : cue.originalText, start: index === 0 ? cue.start + 10 : cue.start })) };
  const result = validateTranslation(source, translated, []);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some(issue => issue.startsWith('timestamp-drift')));
  assert.ok(result.issues.some(issue => issue.startsWith('empty-translation')));
  assert.ok(result.issues.includes('duplicate-cue-id'));
  assert.ok(result.issues.includes('untranslated-lines:3'));
});

test('QA accepts Bulgarian glossary terms in grammatical inflections', () => {
  const source = parseSubtitle('1\n00:00:01,000 --> 00:00:02,000\nScout Regiment\n', 'srt');
  const translated = { ...source, cues: source.cues.map(cue => ({ ...cue, originalText: 'Разузнавателният корпус' })) };
  assert.equal(validateTranslation(source, translated, [{ source: 'Scout Regiment', target: 'Разузнавателния корпус' }]).valid, true);
});

test('QA rejects untranslated Latin fragments mixed into Bulgarian cues', () => {
  const source = parseSubtitle('1\n00:00:01,000 --> 00:00:02,000\nbeing trapped\n', 'srt');
  const translated = { ...source, cues: source.cues.map(cue => ({ ...cue, originalText: 'да бъдеш затворен в клетка, da бъдеш' })) };
  assert.match(validateTranslation(source, translated, []).issues[0]!, /^untranslated-latin-fragment:c1-/);
});

test('QA allows short retained character or organization names within Bulgarian text', () => {
  const source = parseSubtitle('1\n00:00:01,000 --> 00:00:02,000\nHer family owns the Shinomiya Group\n', 'srt');
  const translated = { ...source, cues: source.cues.map(cue => ({ ...cue, originalText: 'Семейството ѝ притежава Shinomiya Group' })) };
  assert.equal(validateTranslation(source, translated, []).valid, true);
});
