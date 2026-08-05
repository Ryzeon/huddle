/**
 * La memoria de la sala, escrita como grafo.
 *
 * Cada respuesta que se da en la sala deja una nota en la carpeta, y cada nota
 * enlaza a un nodo por tema y a uno por persona. Esos nodos acumulan enlaces,
 * así que el grafo *es* el texto: `grep -rl "[[temas/facturacion]]"` devuelve
 * el hilo entero de un salto, sin índice que mantener ni embeddings que
 * caduquen. Y como son `.md` con wikilinks, la carpeta se abre tal cual en
 * cualquier editor de notas enlazadas.
 *
 * Todo aquí es puro: entra una entrada del historial, sale texto.
 */

import type { Alias, SourceRef } from '@huddle/protocol';
import { tokenize } from './routing.js';

export interface NoteSource {
  id: string;
  /** El código de la sala. Va en la nota porque la carpeta se replica fuera. */
  room: string;
  from: Alias;
  to: Alias;
  question: string;
  answer: string;
  sources: SourceRef[];
  confidence: string;
  sha?: string;
  branch?: string;
  at: number;
  /** El repositorio de quien respondió, para saber de qué habla la nota. */
  repo?: string;
  /** El vocabulario de ese repositorio: de ahí salen los temas. */
  keywords?: readonly string[];
}

export interface GeneratedNote {
  path: string;
  text: string;
  /** Rutas de los nodos que hay que enlazar con esta nota. */
  links: string[];
}

/** Cuántos temas se le cuelgan a una nota. Más que esto no clasifica: mancha. */
const MAX_TOPICS = 4;

const MAX_SLUG_LENGTH = 48;

/** El tope de un segmento de ruta en `normalizeFolderPath`. */
const MAX_SEGMENT = 64;

/**
 * De qué trata una respuesta.
 *
 * Los temas salen de cruzar las palabras de la pregunta con el vocabulario del
 * repositorio que la contestó, que el hub ya tiene en la tarjeta de
 * capacidades. Pedírselo al modelo daría etiquetas más finas y costaría una
 * llamada contra la suscripción de quien acaba de responder — justo lo que el
 * diseño de cuotas evita. Esto es gratis, determinista y se prueba.
 */
export function topicsOf(question: string, keywords: readonly string[] = []): string[] {
  const asked = tokenize(question);
  const vocabulary = new Set(tokenize(keywords.join(' ')));

  const matched = unique(asked.filter((term) => vocabulary.has(term)));
  if (matched.length > 0) return matched.slice(0, MAX_TOPICS);

  // Sin vocabulario que cruzar —un repo recién expuesto, o una pregunta que no
  // usa sus palabras— se cae a los términos más largos de la pregunta. Peor
  // clasificado que con vocabulario, pero una nota sin ningún tema queda
  // huérfana en el grafo y no la encuentra nadie.
  return unique(asked)
    .sort((a, b) => b.length - a.length)
    .slice(0, 2);
}

export function slugify(raw: string): string {
  const clean = raw
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/, '');
  return clean || 'nota';
}

/** `@ana` → `ana`. El `@` no es un carácter de nombre de archivo. */
function bare(alias: Alias): string {
  return alias.replace(/^@/, '') || 'alguien';
}

function isoDay(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

function unique(terms: readonly string[]): string[] {
  return [...new Set(terms)];
}

/**
 * La ruta de la nota.
 *
 * Lleva la cola del id además de la fecha y el asunto: dos veces la misma
 * pregunta el mismo día se pisarían, y perder la segunda respuesta —que puede
 * ser distinta, porque el repositorio ha cambiado— es perder justo lo que
 * hacía falta guardar.
 */
export function notePath(source: NoteSource): string {
  const cola = source.id.slice(-4).toLowerCase();
  const prefijo = `${isoDay(source.at)}-${bare(source.to)}`;

  // Lo que le queda al asunto después de la fecha, el alias, la cola y `.md`.
  // Sin esta cuenta, una pregunta larga generaba un nombre de más de 64
  // caracteres: la nota se escribía, pero `normalizeFolderPath` la rechazaba
  // después, así que nadie podía abrirla y no llegaba a ningún disco. El hub
  // no puede generar rutas que su propia frontera no acepte.
  const presupuesto = MAX_SEGMENT - prefijo.length - cola.length - 5;
  const asunto = slugify(source.question).slice(0, Math.max(presupuesto, 0)).replace(/-+$/, '');

  const nombre = asunto ? `${prefijo}-${asunto}-${cola}` : `${prefijo}-${cola}`;
  return `respuestas/${nombre}.md`;
}

export function buildNote(source: NoteSource): GeneratedNote {
  const topics = topicsOf(source.question, source.keywords);
  const links = [
    ...topics.map((topic) => `temas/${slugify(topic)}.md`),
    `gente/${bare(source.to)}.md`,
  ];

  const frontmatter = [
    '---',
    `sala: ${source.room}`,
    `de: "${source.from}"`,
    `a: "${source.to}"`,
    ...(source.repo ? [`repo: ${source.repo}${source.sha ? ` · ${source.sha}` : ''}`] : []),
    `confianza: ${source.confidence}`,
    `at: ${new Date(source.at).toISOString()}`,
    '---',
  ];

  const cuerpo = [
    `# ${source.question.trim()}`,
    '',
    source.answer.trim(),
    '',
  ];

  if (source.sources.length > 0) {
    cuerpo.push(
      `**Fuentes:** ${source.sources
        .map((ref) => `\`${ref.file}${ref.line ? `:${ref.line}` : ''}\``)
        .join(' · ')}`,
    );
  }

  cuerpo.push(
    `**Preguntó** [[gente/${bare(source.from)}]] · **respondió** [[gente/${bare(source.to)}]]`,
  );

  if (topics.length > 0) {
    cuerpo.push(`**Temas:** ${topics.map((t) => `[[temas/${slugify(t)}]]`).join(' · ')}`);
  }

  return {
    path: notePath(source),
    text: `${[...frontmatter, '', ...cuerpo].join('\n')}\n`,
    links,
  };
}

/**
 * Añade un enlace a un nodo del grafo, creándolo si no existía.
 *
 * Devuelve `null` si el enlace ya estaba: sin eso, cada respuesta reescribiría
 * el nodo entero y dispararía una difusión a toda la sala por nada.
 *
 * Un enlace puede quedar apuntando a una nota que la poda se llevó. Se deja
 * así a propósito: un enlace roto dice «aquí hubo algo», y salir a limpiar
 * todos los nodos en cada poda cuesta más de lo que arregla.
 */
export function linkInto(
  previous: string | undefined,
  notePathValue: string,
  nodePath: string,
): string | null {
  const target = notePathValue.replace(/\.md$/, '');
  const line = `- [[${target}]]`;
  if (previous?.includes(line)) return null;

  const title = nodePath.replace(/^(temas|gente)\//, '').replace(/\.md$/, '');
  const head = nodePath.startsWith('gente/')
    ? `# ${title}\n\nLo que ha respondido en esta sala.\n`
    : `# ${title}\n\nLo que se ha preguntado sobre esto en la sala.\n`;

  const body = previous ?? head;
  return `${body.replace(/\n+$/, '')}\n${line}\n`;
}

/** Se escribe una sola vez, cuando la carpeta deja de estar vacía. */
export const FOLDER_README = `# La carpeta de esta sala

Lo que hay aquí lo ve —y lo lee— el agente de todos los miembros de la sala.

- \`notas/\` es vuestro. Escribid aquí lo que queráis que el equipo tenga a mano:
  decisiones, contexto, convenciones. Se puede editar a mano, y los cambios
  suben solos.
- \`respuestas/\`, \`temas/\` y \`gente/\` los escribe el hub con cada respuesta que
  se da en la sala. No los edites: se regeneran.

Los archivos están enlazados con wikilinks, así que \`grep -rl "[[temas/algo]]"\`
saca el hilo entero de un salto.
`;
