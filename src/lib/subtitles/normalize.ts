import { createHash } from 'node:crypto';

export type SubtitleFormat = 'srt' | 'ass' | 'ssa' | 'vtt';
export interface Cue {
  id: string;
  start: number;
  end: number;
  originalText: string;
  translatedText: string;
  formatting: { kind: SubtitleFormat; assPrefix?: string; assFields?: string[]; assTextIndex?: number; tags?: string[] };
  speaker: string | null;
}
export interface NormalizedSubtitle { format: SubtitleFormat; cues: Cue[]; header: string; sourceHash: string; }
const MAX_SUBTITLE_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_SUBTITLE_CUES = 20_000;
const MAX_CUE_TEXT_CHARACTERS = 8_192;

function assertCueCapacity(current: number, body: string): void {
  if (current >= MAX_SUBTITLE_CUES) throw new Error(`Subtitle exceeds ${MAX_SUBTITLE_CUES} cues`);
  if (body.length > MAX_CUE_TEXT_CHARACTERS) throw new Error(`Subtitle cue exceeds ${MAX_CUE_TEXT_CHARACTERS} characters`);
}

function parseTime(value: string): number {
  const normalized = value.trim().replace(',', '.');
  const match = normalized.match(/^(?:(\d+):)?(\d{1,2}):(\d{2})\.(\d{1,3})$/);
  if (!match) throw new Error(`Invalid subtitle timestamp: ${value}`);
  return (((Number(match[1] ?? 0) * 60 + Number(match[2])) * 60 + Number(match[3])) * 1000) + Number(match[4].padEnd(3, '0'));
}
export function formatTime(ms: number, comma = false): string {
  const value = Math.max(0, Math.round(ms));
  const h = Math.floor(value / 3600000);
  const m = Math.floor(value % 3600000 / 60000);
  const s = Math.floor(value % 60000 / 1000);
  const milli = value % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}${comma ? ',' : '.'}${String(milli).padStart(3, '0')}`;
}
function identifyFormat(input: string, preferred?: SubtitleFormat): SubtitleFormat {
  if (preferred) return preferred;
  const head = input.slice(0, 2000);
  if (/\[Script Info\]|\[Events\]/i.test(head)) return /\[Script Info\][\s\S]*?ScriptType:\s*v4\.00\+/i.test(head) ? 'ass' : 'ssa';
  return /^\uFEFF?WEBVTT/m.test(head) ? 'vtt' : 'srt';
}
function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function tagsOf(text: string): string[] { return [...text.matchAll(/\{[^}]*\}/g)].map(match => match[0]); }

export function parseSubtitle(input: string, preferred?: SubtitleFormat): NormalizedSubtitle {
  if (Buffer.byteLength(input, 'utf8') > MAX_SUBTITLE_INPUT_BYTES) throw new Error(`Subtitle exceeds ${MAX_SUBTITLE_INPUT_BYTES} bytes`);
  const sourceHash = hash(input);
  const text = input.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const format = identifyFormat(text, preferred);
  const cues: Cue[] = [];
  let header = '';
  if (format === 'ass' || format === 'ssa') {
    const lines = text.split('\n');
    const eventStart = lines.findIndex(line => /^\[Events\]/i.test(line.trim()));
    const events = eventStart >= 0 ? lines.slice(eventStart + 1).find(line => /^Format:/i.test(line.trim())) : undefined;
    header = eventStart >= 0
      ? `${lines.slice(0, eventStart + 1).join('\n')}\n${events ? `${events}\n` : ''}`
      : '[Script Info]\nScriptType: v4.00+\n[V4+ Styles]\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n';
    let fields = ['Layer', 'Start', 'End', 'Style', 'Name', 'MarginL', 'MarginR', 'MarginV', 'Effect', 'Text'];
    let ordinal = 0;
    const usedIds = new Set<string>();
    for (const line of lines.slice(Math.max(0, eventStart + 1))) {
      if (/^Format:/i.test(line.trim())) { fields = line.slice(line.indexOf(':') + 1).split(',').map(field => field.trim()); continue; }
      if (!/^Dialogue:/i.test(line)) continue;
      const raw = line.slice(line.indexOf(':') + 1).trimStart();
      const parts = raw.split(',');
      const textIndex = fields.findIndex(field => field.toLowerCase() === 'text');
      if (textIndex < 0 || parts.length <= textIndex) continue;
      const values = [...parts.slice(0, textIndex), parts.slice(textIndex).join(',')];
      const startIndex = fields.findIndex(field => field.toLowerCase() === 'start');
      const endIndex = fields.findIndex(field => field.toLowerCase() === 'end');
      if (startIndex < 0 || endIndex < 0) continue;
      const start = parseTime(values[startIndex] ?? '');
      const end = parseTime(values[endIndex] ?? '');
      if (end <= start) continue;
      const dialogue = values[textIndex] ?? '';
      assertCueCapacity(cues.length, dialogue);
      const speakerIndex = fields.findIndex(field => ['name', 'actor'].includes(field.toLowerCase()));
      const cueFields = [...values];
      cueFields[textIndex] = '';
      ordinal++;
      let id = `c${ordinal}-${hash(`${start}:${end}`).slice(0, 8)}`;
      while (usedIds.has(id)) id = `c${ordinal}-${hash(`${start}:${end}:${ordinal}:${usedIds.size}`).slice(0, 8)}`;
      usedIds.add(id);
      cues.push({ id, start, end, originalText: dialogue, translatedText: '', formatting: { kind: format, assPrefix: 'Dialogue: ', assFields: cueFields, assTextIndex: textIndex, tags: tagsOf(dialogue) }, speaker: speakerIndex < 0 ? null : values[speakerIndex] || null });
    }
  } else {
    const blocks = text.split(/\n[ \t]*\n/);
    if (format === 'vtt') header = text.split('\n').slice(0, text.split('\n').findIndex(line => line.trim() === '') + 1).join('\n');
    let ordinal = 0;
    const usedIds = new Set<string>();
    for (const block of blocks) {
      const lines = block.split('\n');
      const timeIndex = lines.findIndex(line => /\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}\s*-->\s*\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}/.test(line));
      if (timeIndex < 0) continue;
      const match = lines[timeIndex]!.match(/(\d{1,2}:\d{2}:\d{2}[.,]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[.,]\d{1,3})/);
      if (!match) continue;
      const start = parseTime(match[1]!); const end = parseTime(match[2]!);
      if (end <= start) continue;
      const body = lines.slice(timeIndex + 1).join('\n').trim();
      if (!body) continue;
      assertCueCapacity(cues.length, body);
      ordinal++;
      const candidateId = format === 'vtt' ? lines[timeIndex - 1]?.trim() : undefined;
      let id = candidateId && candidateId !== 'WEBVTT' && !candidateId.includes('-->')
        ? candidateId
        : `c${ordinal}-${hash(`${start}:${end}`).slice(0, 8)}`;
      if (usedIds.has(id)) id = `c${ordinal}-${hash(`${start}:${end}:${ordinal}:${usedIds.size}`).slice(0, 8)}`;
      usedIds.add(id);
      cues.push({ id, start, end, originalText: body, translatedText: '', formatting: { kind: format, tags: tagsOf(body) }, speaker: null });
    }
  }
  if (!cues.length) throw new Error(`No valid ${format.toUpperCase()} subtitle cues were parsed`);
  return { format, cues, header, sourceHash };
}

export function serializeSubtitle(subtitle: NormalizedSubtitle, translated = true): string {
  if (subtitle.format === 'ass' || subtitle.format === 'ssa') {
    const rows = subtitle.cues.map(cue => {
      const fields = [...(cue.formatting.assFields ?? [])];
      const index = cue.formatting.assTextIndex ?? fields.length - 1;
      fields[index] = translated && cue.translatedText ? cue.translatedText : cue.originalText;
      return `${cue.formatting.assPrefix ?? 'Dialogue: '}${fields.join(',')}`;
    });
    return `${subtitle.header.replace(/\n?$/, '\n')}${rows.join('\n')}\n`;
  }
  const rows = subtitle.cues.map((cue, index) => `${subtitle.format === 'vtt' ? cue.id : index + 1}\n${formatTime(cue.start, subtitle.format === 'srt')} --> ${formatTime(cue.end, subtitle.format === 'srt')}\n${translated && cue.translatedText ? cue.translatedText : cue.originalText}`);
  return `${subtitle.format === 'vtt' ? `${subtitle.header || 'WEBVTT'}\n\n` : ''}${rows.join('\n\n')}\n`;
}
