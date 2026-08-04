/**
 * La caja de escribir: menciones con autocompletado y el comando `/ask`.
 *
 * Decide qué se sugiere y qué se manda sin tocar el `<textarea>`. La vista lee
 * el cursor, llama a estas funciones y aplica el resultado.
 */

/** Una mención a medio escribir, localizada en el texto. */
export interface MentionQuery {
  /** Índice del `@`. */
  start: number;
  /** Índice justo después de lo tecleado. */
  end: number;
  /** Lo escrito tras el `@`, en minúsculas y sin el `@`. */
  query: string;
}

const MENTION_CHARS = /^[a-z0-9_:-]*$/i;

/**
 * Busca la mención que se está escribiendo en la posición del cursor.
 *
 * Solo cuenta si el `@` va precedido de espacio o de principio de línea: en
 * medio de una palabra (`correo@dominio`) no es una mención.
 */
export function findMentionQuery(text: string, caret: number): MentionQuery | null {
  const position = Math.max(0, Math.min(caret, text.length));
  let start = -1;
  for (let i = position - 1; i >= 0; i--) {
    const char = text[i] ?? '';
    if (char === '@') {
      start = i;
      break;
    }
    if (!MENTION_CHARS.test(char)) return null;
  }
  if (start < 0) return null;

  const previous = start > 0 ? text[start - 1] ?? '' : '';
  if (previous !== '' && !/\s/.test(previous)) return null;

  return {
    start,
    end: position,
    query: text.slice(start + 1, position).toLowerCase(),
  };
}

/**
 * Ordena los candidatos para una consulta: primero los que empiezan por lo
 * tecleado, después los que lo contienen, y a igualdad, alfabético. Con la
 * consulta vacía devuelve todo en orden.
 */
export function rankMentions(query: string, candidates: readonly string[]): string[] {
  const needle = query.toLowerCase();
  const scored: Array<{ label: string; score: number }> = [];

  for (const candidate of candidates) {
    const haystack = candidate.toLowerCase().replace(/^@/, '');
    if (needle === '') {
      scored.push({ label: candidate, score: 1 });
      continue;
    }
    if (haystack.startsWith(needle)) scored.push({ label: candidate, score: 0 });
    else if (haystack.includes(needle)) scored.push({ label: candidate, score: 1 });
  }

  return scored
    .sort((a, b) => (a.score !== b.score ? a.score - b.score : a.label.localeCompare(b.label)))
    .map((item) => item.label);
}

export interface AppliedMention {
  text: string;
  caret: number;
}

/** Sustituye la mención a medio escribir por el candidato, y deja un espacio. */
export function applyMention(
  text: string,
  mention: MentionQuery,
  candidate: string,
): AppliedMention {
  const inserted = `${candidate} `;
  return {
    text: text.slice(0, mention.start) + inserted + text.slice(mention.end),
    caret: mention.start + inserted.length,
  };
}

// ---------------------------------------------------------------------------
// Qué se manda al pulsar enter
// ---------------------------------------------------------------------------

export type Draft =
  | { kind: 'empty' }
  | { kind: 'message'; text: string }
  | { kind: 'ask'; to: string; question: string }
  | { kind: 'invalid'; reason: string };

const ASK_RE = /^\/(?:ask|preguntar)\s+(@[a-z0-9][a-z0-9_-]{0,31}(?::[a-z0-9][a-z0-9_-]{0,31})?)\s+([\s\S]+)$/i;

/**
 * Interpreta lo escrito. Por defecto es chat humano; `/ask @alias pregunta`
 * (o `/preguntar`) dispara una pregunta real al agente de esa persona, cuya
 * respuesta llega solo a quien preguntó.
 */
export function parseDraft(raw: string): Draft {
  const text = raw.trim();
  if (text === '') return { kind: 'empty' };

  if (text.startsWith('/')) {
    const ask = ASK_RE.exec(text);
    if (ask) {
      return { kind: 'ask', to: ask[1]!.toLowerCase(), question: ask[2]!.trim() };
    }
    if (/^\/(ask|preguntar)\b/i.test(text)) {
      return { kind: 'invalid', reason: 'usa: /ask @alias tu pregunta' };
    }
    return { kind: 'invalid', reason: `comando desconocido: ${text.split(/\s/)[0] ?? ''}` };
  }

  return { kind: 'message', text };
}
