#!/usr/bin/env python3
"""Subtitle production helpers. Timings always originate from the supplied audio."""
from __future__ import annotations
import argparse
import json
import os
import re
import subprocess
import sys
import textwrap
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path

TIMING = re.compile(r'^(\d{2}:\d{2}:\d{2}[,.]\d{3})\s+-->\s+(\d{2}:\d{2}:\d{2}[,.]\d{3})(.*)$')
ALIGN = re.compile(r'\{\\an\d+\}')
FONT = re.compile(r'</?font(?:\s+[^>]*)?>', re.I)

@dataclass
class Cue:
    start: str
    end: str
    text: str
    timing_line: str | None = None


def ms(value: str) -> int:
    h, m, tail = value.replace(',', '.').split(':')
    s, milli = tail.split('.')
    return ((int(h) * 60 + int(m)) * 60 + int(s)) * 1000 + int(milli)


def stamp(value: int) -> str:
    value = max(0, value)
    h, rem = divmod(value, 3_600_000); m, rem = divmod(rem, 60_000); s, milli = divmod(rem, 1000)
    return f'{h:02}:{m:02}:{s:02}.{milli:03}'


def parse_srt(path: Path) -> list[Cue]:
    raw = path.read_text(encoding='utf-8-sig').strip()
    cues: list[Cue] = []
    for block in re.split(r'\n\s*\n', raw):
        lines = block.splitlines()
        match = next((TIMING.match(line.strip()) for line in lines if TIMING.match(line.strip())), None)
        if not match: continue
        index = lines.index(next(line for line in lines if TIMING.match(line.strip())))
        cues.append(Cue(match.group(1), match.group(2), '\n'.join(lines[index + 1:]).strip(), match.group(0)))
    return cues


def request_json(url: str, payload: dict, headers: dict[str, str]) -> dict:
    request = urllib.request.Request(url, data=json.dumps(payload).encode(), headers={**headers, 'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(request, timeout=90) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode(errors='replace')
        raise RuntimeError(f'Translation service returned HTTP {exc.code}: {detail}') from exc


def translate_batch(texts: list[str], context: str, glossary: dict[str, str], provider: str) -> list[str]:
    rules = '\n'.join(f'- Translate {source!r} as exactly {target!r}.' for source, target in glossary.items()) or '- Preserve character names consistently.'
    if provider == 'openai':
        key = os.environ['OPENAI_API_KEY']
        prompt = ('Translate the Japanese dialogue into natural Bulgarian. Return a JSON object with a "translations" array of strings in the same order, one translation per input cue. '
                  'Do not add, remove, combine, or split cues. Preserve inline markup. Keep each line concise for subtitles.\n'
                  f'Glossary:\n{rules}\nPrevious five cues for context (do not translate these):\n{context or "(none)"}\nCues:\n' + json.dumps(texts, ensure_ascii=False))
        result = request_json('https://api.openai.com/v1/chat/completions',
            {'model': 'gpt-4o-mini', 'temperature': 0.2, 'messages': [{'role': 'user', 'content': prompt}], 'response_format': {'type': 'json_object'}},
            {'Authorization': f'Bearer {key}'})
        content = result['choices'][0]['message']['content']
        parsed = json.loads(content)
        values = parsed.get('translations') if isinstance(parsed, dict) else parsed
        if not isinstance(values, list): raise RuntimeError('OpenAI returned no translations array')
        return [str(value) for value in values]
    key = os.environ['DEEPL_API_KEY']
    payload = {'text': texts, 'target_lang': 'BG', 'source_lang': 'JA', 'context': f'{context}\nGlossary: {rules}'}
    result = request_json('https://api-free.deepl.com/v2/translate', payload, {'Authorization': f'DeepL-Auth-Key {key}'})
    translated = [str(item['text']) for item in result.get('translations', [])]
    for index, value in enumerate(translated):
        for source, target in glossary.items():
            value = re.sub(re.escape(source), target, value, flags=re.I)
        translated[index] = value
    return translated


def command_extract(args: argparse.Namespace) -> None:
    subprocess.run(['ffmpeg', '-i', args.m3u8, '-vn', '-ac', '1', '-ar', '16000', '-f', 'wav', args.out], check=True)


def command_transcribe(args: argparse.Namespace) -> None:
    try: from faster_whisper import WhisperModel
    except ImportError as exc: raise SystemExit('Install faster-whisper to transcribe: pip install faster-whisper') from exc
    model = WhisperModel('large-v3', device='auto', compute_type='auto')
    segments, _ = model.transcribe(args.wav, language='ja', vad_filter=True)
    with open(args.out, 'w', encoding='utf-8') as output:
        for number, segment in enumerate(segments, 1):
            def fmt(seconds: float) -> str:
                total = round(seconds * 1000); h, rem = divmod(total, 3_600_000); m, rem = divmod(rem, 60_000); s, milli = divmod(rem, 1000)
                return f'{h:02}:{m:02}:{s:02},{milli:03}'
            output.write(f'{number}\n{fmt(segment.start)} --> {fmt(segment.end)}\n{segment.text.strip()}\n\n')


def command_translate(args: argparse.Namespace) -> None:
    if not os.environ.get('OPENAI_API_KEY') and not os.environ.get('DEEPL_API_KEY'):
        raise SystemExit('Set OPENAI_API_KEY or DEEPL_API_KEY in the environment before translating.')
    provider = 'openai' if os.environ.get('OPENAI_API_KEY') else 'deepl'
    glossary = json.loads(Path(args.glossary).read_text(encoding='utf-8')) if args.glossary else {}
    cues = parse_srt(Path(args.input))
    output: list[str] = []
    prior: list[str] = []
    for offset in range(0, len(cues), 40):
        batch = cues[offset:offset + 40]
        context = '\n'.join(prior[-5:])
        translated = translate_batch([cue.text for cue in batch], context, glossary, provider)
        if len(translated) != len(batch):
            raise RuntimeError(f'Translation changed cue count: expected {len(batch)}, received {len(translated)}')
        for cue, text in zip(batch, translated):
            output.extend([cue.timing_line or f'{cue.start} --> {cue.end}', text.strip(), ''])
        prior.extend(cue.text for cue in batch)
    Path(args.output).write_text('\n'.join(output).rstrip() + '\n', encoding='utf-8')


def wrap_text(value: str) -> list[str]:
    clean = ALIGN.sub('', value); clean = FONT.sub('', clean)
    result: list[str] = []
    for raw_line in clean.splitlines() or ['']:
        result.extend(textwrap.wrap(raw_line, width=42, break_long_words=True, break_on_hyphens=False) or [''])
    if len(result) > 2:
        result = result[:2]
        result[1] = textwrap.shorten(result[1], width=42, placeholder='…')
    return result


def command_to_vtt(args: argparse.Namespace) -> None:
    cues = parse_srt(Path(args.input))
    converted: list[Cue] = []
    index = 0
    while index < len(cues):
        cue = cues[index]
        start, end = ms(cue.start), ms(cue.end)
        lines = wrap_text(cue.text)
        current = Cue(stamp(start), stamp(end), '\n'.join(lines))
        if end - start < 800 and index + 1 < len(cues):
            following = cues[index + 1]
            current.end = stamp(ms(following.end))
            current.text = '\n'.join(wrap_text(current.text.replace('\n', ' ') + ' ' + following.text.replace('\n', ' ')))
            index += 1
            if converted:
                previous = converted[-1]
                previous.end = current.end
                previous.text = '\n'.join(wrap_text(previous.text.replace('\n', ' ') + ' ' + current.text.replace('\n', ' ')))
            else:
                converted.append(current)
        elif end - start < 800 and converted:
            previous = converted[-1]
            previous.end = current.end
            previous.text = '\n'.join(wrap_text(previous.text.replace('\n', ' ') + ' ' + current.text.replace('\n', ' ')))
        else:
            converted.append(current)
        index += 1
    blocks = ['WEBVTT', '']
    for cue in converted:
        blocks.extend([f'{cue.start} --> {cue.end}', cue.text, ''])
    Path(args.output).write_text('\n'.join(blocks), encoding='utf-8')


def command_check(args: argparse.Namespace) -> None:
    path = Path(args.input)
    raw = path.read_text(encoding='utf-8-sig').strip()
    blocks = re.split(r'\n\s*\n', re.sub(r'^WEBVTT[^\n]*\n', '', raw))
    errors: list[str] = []
    prior_end = -1
    for number, block in enumerate(blocks, 1):
        lines = [line.rstrip('\r') for line in block.splitlines()]
        if not lines: continue
        index = next((i for i, line in enumerate(lines) if '-->' in line), None)
        if index is None: errors.append(f'cue {number}: missing timing'); continue
        match = TIMING.match(lines[index])
        if not match: errors.append(f'cue {number}: invalid timing'); continue
        start, end = ms(match.group(1)), ms(match.group(2)); text_lines = lines[index + 1:]
        if end <= start: errors.append(f'cue {number}: end must follow start'); continue
        duration = end - start
        if duration < 700: errors.append(f'cue {number}: under 700ms ({duration}ms)')
        if duration > 7000: errors.append(f'cue {number}: over 7s ({duration}ms)')
        if start < prior_end: errors.append(f'cue {number}: overlaps previous cue')
        prior_end = max(prior_end, end)
        if len(text_lines) > 2: errors.append(f'cue {number}: more than 2 lines')
        for line in text_lines:
            visible = re.sub(r'<[^>]+>', '', line)
            if len(visible) > 42: errors.append(f'cue {number}: line over 42 characters ({len(visible)})')
        chars = sum(len(re.sub(r'<[^>]+>', '', line)) for line in text_lines)
        cps = chars / (duration / 1000)
        if cps > 21: errors.append(f'cue {number}: CPS over 21 ({cps:.1f})')
    if errors:
        print('\n'.join(errors), file=sys.stderr); raise SystemExit(1)
    print(f'OK: {path} passed subtitle checks')


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    extract = commands.add_parser('extract'); extract.add_argument('m3u8'); extract.add_argument('out'); extract.set_defaults(func=command_extract)
    transcribe = commands.add_parser('transcribe'); transcribe.add_argument('wav'); transcribe.add_argument('out'); transcribe.set_defaults(func=command_transcribe)
    translate = commands.add_parser('translate'); translate.add_argument('input'); translate.add_argument('output'); translate.add_argument('--glossary', required=True); translate.set_defaults(func=command_translate)
    convert = commands.add_parser('to-vtt'); convert.add_argument('input'); convert.add_argument('output'); convert.set_defaults(func=command_to_vtt)
    check = commands.add_parser('check'); check.add_argument('input'); check.set_defaults(func=command_check)
    args = parser.parse_args(); args.func(args)

if __name__ == '__main__': main()
