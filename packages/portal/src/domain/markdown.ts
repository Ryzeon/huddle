// Markdown mínimo, el que de verdad usa una respuesta: bloques de código,
// listas, citas, código en línea, negrita, cursiva y menciones.
//
// Devuelve una estructura, no HTML. Quien pinta construye nodos con
// `textContent`, así que no hay forma de inyectar nada desde otra máquina.

export type Inline =
  | { kind: 'text'; value: string }
  | { kind: 'code'; value: string }
  | { kind: 'bold'; value: string }
  | { kind: 'italic'; value: string }
  | { kind: 'mention'; value: string };

export type Block =
  | { kind: 'paragraph'; content: Inline[] }
  | { kind: 'code'; language?: string; value: string }
  | { kind: 'list'; ordered: boolean; items: Inline[][] }
  | { kind: 'quote'; content: Inline[] }
  | { kind: 'heading'; level: number; content: Inline[] };

const FENCE = /^```(\w+)?\s*$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const HEADING = /^(#{1,4})\s+(.*)$/;

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? '';

    if (!line.trim()) {
      i++;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const cuerpo: string[] = [];
      i++;
      // Una valla sin cerrar llega hasta el final: cortar por la mitad
      // escondería texto que el usuario sí escribió.
      while (i < lines.length && !FENCE.test(lines[i] ?? '')) {
        cuerpo.push(lines[i] ?? '');
        i++;
      }
      i++;
      const bloque: Block = { kind: 'code', value: cuerpo.join('\n') };
      if (fence[1]) bloque.language = fence[1];
      blocks.push(bloque);
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({
        kind: 'heading',
        level: (heading[1] ?? '#').length,
        content: parseInline(heading[2] ?? ''),
      });
      i++;
      continue;
    }

    if (BULLET.test(line) || NUMBERED.test(line)) {
      const ordered = !BULLET.test(line);
      const items: Inline[][] = [];
      while (i < lines.length) {
        const actual = lines[i] ?? '';
        const match = ordered ? NUMBERED.exec(actual) : BULLET.exec(actual);
        if (!match) break;
        items.push(parseInline(match[1] ?? ''));
        i++;
      }
      blocks.push({ kind: 'list', ordered, items });
      continue;
    }

    if (QUOTE.test(line)) {
      const texto: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i] ?? '')) {
        texto.push(QUOTE.exec(lines[i] ?? '')?.[1] ?? '');
        i++;
      }
      blocks.push({ kind: 'quote', content: parseInline(texto.join(' ')) });
      continue;
    }

    // Párrafo: se junta hasta la línea en blanco o hasta que empiece otro bloque.
    const parrafo: string[] = [];
    while (i < lines.length) {
      const actual = lines[i] ?? '';
      if (!actual.trim() || FENCE.test(actual) || BULLET.test(actual) ||
          NUMBERED.test(actual) || QUOTE.test(actual) || HEADING.test(actual)) break;
      parrafo.push(actual.trim());
      i++;
    }
    blocks.push({ kind: 'paragraph', content: parseInline(parrafo.join(' ')) });
  }

  return blocks;
}

const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(@[a-z0-9_-]+(?::[a-z0-9_-]+)?)/gi;

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;

  for (const match of text.matchAll(INLINE)) {
    const at = match.index;
    if (at > last) out.push({ kind: 'text', value: text.slice(last, at) });

    const [todo, code, bold, italic, mention] = match;
    if (code) out.push({ kind: 'code', value: code.slice(1, -1) });
    else if (bold) out.push({ kind: 'bold', value: bold.slice(2, -2) });
    else if (italic) out.push({ kind: 'italic', value: italic.slice(1, -1) });
    else if (mention) out.push({ kind: 'mention', value: mention });

    last = at + todo.length;
  }

  if (last < text.length) out.push({ kind: 'text', value: text.slice(last) });
  return out;
}

/** El texto plano de un bloque, que es lo que se copia al portapapeles. */
export function blockToText(block: Block): string {
  switch (block.kind) {
    case 'code':
      return block.value;
    case 'list':
      return block.items.map((item, n) =>
        `${block.ordered ? `${n + 1}.` : '-'} ${inlineToText(item)}`).join('\n');
    default:
      return inlineToText(block.content);
  }
}

function inlineToText(content: Inline[]): string {
  return content.map((part) => part.value).join('');
}
