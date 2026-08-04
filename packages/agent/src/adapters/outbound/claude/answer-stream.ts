const KEY_PATTERN = /"answer"\s*:\s*"/;

export class AnswerStreamExtractor {
  private buffer = '';
  private valueStart = -1;
  private emitted = 0;
  private finished = false;

  push(rawChunk: string): string {
    if (this.finished) return '';
    this.buffer += rawChunk;

    if (this.valueStart < 0) {
      const match = KEY_PATTERN.exec(this.buffer);
      if (!match) return '';
      this.valueStart = match.index + match[0].length;
    }

    const { text, closed } = decodeJsonStringPrefix(this.buffer, this.valueStart);
    if (closed) this.finished = true;

    if (text.length <= this.emitted) return '';
    const delta = text.slice(this.emitted);
    this.emitted = text.length;
    return delta;
  }

  get isComplete(): boolean {
    return this.finished;
  }

  get text(): string {
    if (this.valueStart < 0) return '';
    return decodeJsonStringPrefix(this.buffer, this.valueStart).text.slice(0, this.emitted);
  }
}

const SIMPLE_ESCAPES: Record<string, string> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
};

export function decodeJsonStringPrefix(
  buffer: string,
  start: number,
): { text: string; closed: boolean } {
  let out = '';
  let i = start;

  while (i < buffer.length) {
    const ch = buffer[i]!;

    if (ch === '"') return { text: out, closed: true };

    if (ch !== '\\') {
      out += ch;
      i += 1;
      continue;
    }

    // A partir de aquí es un escape; puede venir cortado por la mitad.
    if (i + 1 >= buffer.length) break;
    const marker = buffer[i + 1]!;

    if (marker === 'u') {
      if (i + 6 > buffer.length) break; // \uXXXX incompleto
      const hex = buffer.slice(i + 2, i + 6);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
      out += String.fromCharCode(Number.parseInt(hex, 16));
      i += 6;
      continue;
    }

    const simple = SIMPLE_ESCAPES[marker];
    if (simple === undefined) break; // escape inválido: no inventamos nada
    out += simple;
    i += 2;
  }

  return { text: out, closed: false };
}
