import type { LogEntry } from './session-state.js';

export type Tone = 'muted' | 'normal' | 'accent' | 'ok' | 'bad';

export interface FormattedEntry {
  id: string;
  glyph: string;
  text: string;
  alias?: string;
  meta?: string;
  tone: Tone;
  quoted: boolean;
  time: string;
  sources?: string[];
}

export function formatEntry(entry: LogEntry): FormattedEntry {
  const base = {
    id: entry.id,
    time: formatTime(entry.at),
  };

  switch (entry.kind) {
    case 'joined':
      return {
        ...base,
        glyph: '→',
        alias: entry.alias ?? '',
        text: 'entró a la sala',
        ...(entry.meta ? { meta: entry.meta } : {}),
        tone: 'ok',
        quoted: false,
      };
    case 'left':
      return {
        ...base,
        glyph: '←',
        alias: entry.alias ?? '',
        text: 'salió de la sala',
        tone: 'muted',
        quoted: false,
      };
    case 'kicked':
      return {
        ...base,
        glyph: '×',
        alias: entry.alias ?? '',
        text: entry.text ?? 'fue expulsado',
        ...(entry.meta ? { meta: entry.meta } : {}),
        tone: 'bad',
        quoted: false,
      };
    case 'host':
      return {
        ...base,
        glyph: '◆',
        alias: entry.alias ?? '',
        text: 'es ahora el anfitrión',
        ...(entry.meta ? { meta: entry.meta } : {}),
        tone: 'accent',
        quoted: false,
      };
    case 'message':
      return {
        ...base,
        glyph: '>',
        alias: entry.alias ?? '',
        text: entry.text ?? '',
        tone: 'normal',
        quoted: true,
      };
    case 'ask':
      return {
        ...base,
        glyph: '?',
        alias: entry.alias ?? '',
        text: `preguntó a ${entry.target ?? '@?'}`,
        ...(entry.meta ? { meta: entry.meta } : {}),
        tone: 'accent',
        quoted: false,
      };
    case 'answer':
      return {
        ...base,
        glyph: '✓',
        alias: entry.alias ?? '',
        text: entry.text ?? `respondió a ${entry.target ?? '@?'}`,
        ...(entry.meta ? { meta: entry.meta } : {}),
        tone: 'ok',
        quoted: entry.text !== undefined,
        ...(entry.sources && entry.sources.length > 0
          ? { sources: entry.sources.map(formatSource) }
          : {}),
      };
    case 'failed':
      return {
        ...base,
        glyph: '!',
        alias: entry.alias ?? '',
        text: entry.text ?? `no pudo responder a ${entry.target ?? '@?'}`,
        ...(entry.meta ? { meta: entry.meta } : {}),
        tone: 'bad',
        quoted: false,
      };
    case 'system':
    default:
      return {
        ...base,
        glyph: '·',
        text: entry.text ?? '',
        ...(entry.meta ? { meta: entry.meta } : {}),
        tone: 'muted',
        quoted: false,
      };
  }
}

export function formatSource(source: { file: string; line?: number }): string {
  return source.line !== undefined ? `${source.file}:${source.line}` : source.file;
}

export function formatTime(at: number): string {
  const date = new Date(at);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

export interface TextChunk {
  kind: 'text' | 'mention';
  value: string;
}

const MENTION_RE = /@[a-z0-9][a-z0-9_-]{0,31}(:[a-z0-9][a-z0-9_-]{0,31})?/gi;

export function splitMentions(text: string): TextChunk[] {
  const chunks: TextChunk[] = [];
  let last = 0;
  for (const match of text.matchAll(MENTION_RE)) {
    const start = match.index;
    if (start > last) chunks.push({ kind: 'text', value: text.slice(last, start) });
    chunks.push({ kind: 'mention', value: match[0] });
    last = start + match[0].length;
  }
  if (last < text.length) chunks.push({ kind: 'text', value: text.slice(last) });
  return chunks;
}
