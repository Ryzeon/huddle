/**
 * A quién le llega una pregunta.
 *
 * Reglas puras sobre miembros: sin sockets, sin hub, sin estado global.
 * Es la lógica que más se equivoca en silencio (mandarle una pregunta de
 * `payments` a quien tiene abierto infra), así que va aislada y testeada.
 */

import type { Alias, Target } from '@huddle/protocol';
import type { RoomMember } from './member.js';

const STOPWORDS = new Set([
  'que', 'como', 'donde', 'cual', 'esta', 'este', 'para', 'por', 'con', 'los',
  'las', 'del', 'una', 'the', 'and', 'for', 'how', 'what', 'where', 'does',
  'why', 'when', 'who', 'esto', 'eso', 'hay', 'son', 'esa', 'ese',

  // Verbos de acción: valen para cualquier repositorio, así que puntuar con
  // ellos es ruido. Una pregunta por "enviar facturas" enganchaba con el repo
  // de mensajería, que dice "enviar mensajes", en vez de con el de facturas.
  'enviar', 'envio', 'mandar', 'crear', 'creo', 'hacer', 'hace', 'usar', 'usa',
  'obtener', 'poner', 'mostrar', 'listar', 'guardar', 'borrar', 'leer',
  'send', 'sends', 'create', 'make', 'use', 'uses', 'get', 'set', 'list',
  'show', 'save', 'delete', 'read', 'add', 'run', 'runs',
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9_]+/)
    .filter((word) => word.length > 2 && !STOPWORDS.has(word))
    .map(stem);
}

/**
 * Lematización mínima para plurales.
 *
 * Sin esto, "sala" y "salas" son términos distintos y el ruteo falla — que es
 * exactamente lo que pasó: una pregunta sobre "códigos de sala" no enganchó
 * con un repositorio cuyo resumen empieza por "Salas donde…". En español el
 * plural aparece en casi toda frase, así que ignorarlo no es una optimización
 * pendiente, es un fallo.
 *
 * Deliberadamente tonto: no es un stemmer de verdad (no toca género, verbos ni
 * irregulares). Solo tiene que hacer que singular y plural coincidan.
 */
export function stem(word: string): string {
  if (word.length > 4 && word.endsWith('es')) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s')) return word.slice(0, -1);
  return word;
}

export function leastBusy(candidates: RoomMember[]): RoomMember | undefined {
  if (candidates.length === 0) return undefined;
  return candidates.reduce((best, c) => (c.inFlight < best.inFlight ? c : best));
}

export function candidatesByPerson(members: RoomMember[], asker: Alias): RoomMember[] {
  const byAlias = new Map<Alias, RoomMember[]>();
  for (const member of members) {
    if (member.alias === asker || member.viewer) continue;
    const group = byAlias.get(member.alias);
    if (group) group.push(member);
    else byAlias.set(member.alias, [member]);
  }

  const out: RoomMember[] = [];
  for (const group of byAlias.values()) {
    const picked = leastBusy(group);
    if (picked) out.push(picked);
  }
  return out;
}

export function scoreMember(member: RoomMember, questionTerms: string[]): number {
  const haystack = new Set(
    tokenize(
      [
        member.card?.repo ?? '',
        member.card?.remote ?? '',
        member.card?.summary ?? '',
        ...(member.card?.dirs ?? []),
        ...(member.card?.keywords ?? []),
      ].join(' '),
    ),
  );
  let score = 0;
  for (const term of questionTerms) if (haystack.has(term)) score += 1;
  return score;
}

function sameRepo(a: RoomMember, b: RoomMember): boolean {
  const left = a.card?.repo;
  return Boolean(left) && left === b.card?.repo;
}

export function rankByFit(
  members: RoomMember[],
  asker: Alias,
  question: string,
): RoomMember[] {
  const terms = tokenize(question);
  return candidatesByPerson(members, asker)
    .map((member) => ({ member, score: scoreMember(member, terms) }))
    .sort((a, b) => b.score - a.score || a.member.inFlight - b.member.inFlight)
    .map((entry) => entry.member);
}

export type AutoOutcome =
  | { targets: RoomMember[]; reason?: undefined }
  | { targets: []; reason: 'no_members' | 'ambiguous' };

export function resolveAuto(
  members: RoomMember[],
  asker: Alias,
  question: string,
): AutoOutcome {
  // Se puntúan TODOS los repositorios, no uno por persona.
  //
  // `candidatesByPerson` existe para `@all`, donde preguntarle dos veces al
  // mismo humano gasta su cuota por partida doble. Aplicarlo aquí colapsaba
  // los repositorios de una misma persona *antes* de puntuar, eligiendo por
  // "quién está menos ocupado" — o sea, al azar. Con ello `@auto` no podía
  // distinguir entre `@dev:facturacion` y `@dev:salas`, que es justo para lo
  // que sirve.
  const candidates = members.filter((member) => member.alias !== asker && !member.viewer);
  if (candidates.length === 0) return { targets: [], reason: 'no_members' };

  // Con un solo candidato no hay nada que decidir: va para él.
  if (candidates.length === 1) return { targets: candidates };

  const terms = tokenize(question);
  const scored = candidates
    .map((member) => ({ member, score: scoreMember(member, terms) }))
    .sort((a, b) => b.score - a.score || a.member.inFlight - b.member.inFlight);

  const best = scored[0];
  if (!best || best.score === 0) return { targets: [], reason: 'ambiguous' };

  // Un empate entre repositorios distintos no es una decisión.
  //
  // Cuando dos tarjetas puntúan igual, el orden lo decide "quién está menos
  // ocupado". Eso vale si son el mismo repositorio replicado por dos personas,
  // porque cualquiera de las dos sabe responder. Si son repositorios
  // distintos, es azar con cara de criterio: mejor decir que no se sabe.
  //
  // Importa más desde que las tarjetas se amplían: con más términos hay más
  // coincidencias sueltas, y un empate a uno se colaría como decisión.
  const runnerUp = scored[1];
  if (runnerUp && runnerUp.score === best.score && !sameRepo(best.member, runnerUp.member)) {
    return { targets: [], reason: 'ambiguous' };
  }

  return { targets: [best.member] };
}

export function resolveTargets(
  members: RoomMember[],
  target: Target,
  asker: Alias,
  question: string,
): RoomMember[] {
  if (target === '@all') {
    // Un tag por persona: preguntarle dos veces al mismo humano gasta su
    // cuota dos veces para obtener la misma respuesta.
    return candidatesByPerson(members, asker);
  }

  if (target === '@auto') return resolveAuto(members, asker, question).targets;

  const picked = leastBusy(members.filter((m) => m.alias === target && !m.viewer));
  return picked ? [picked] : [];
}
