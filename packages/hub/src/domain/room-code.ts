/**
 * Código de sala.
 *
 * Sustituye al token compartido: es la única llave, así que tiene que ser
 * legible por teléfono **y** no adivinable. Base32 sin vocales ni caracteres
 * ambiguos (0/O, 1/I/L) para que nadie se equivoque al dictarlo.
 *
 * 10 símbolos de un alfabeto de 26 ≈ 2^47 combinaciones. Con el límite de
 * intentos del hub, adivinarlo por fuerza bruta no es una vía realista.
 */

import { randomInt } from 'node:crypto';

/** Sin vocales (evita palabras ofensivas al azar) ni 0/O/1/I/L. */
const ALPHABET = 'BCDFGHJKMNPQRSTVWXYZ23456789';
const GROUP = 5;
const GROUPS = 2;

export function generateRoomCode(random: (max: number) => number = randomInt): string {
  const groups: string[] = [];
  for (let g = 0; g < GROUPS; g++) {
    let group = '';
    for (let i = 0; i < GROUP; i++) group += ALPHABET[random(ALPHABET.length)];
    groups.push(group);
  }
  return groups.join('-');
}

/** Acepta minúsculas y espacios: la gente lo teclea a mano. */
export function normalizeRoomCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, '');
}

export function isValidRoomCode(raw: string): boolean {
  return new RegExp(`^[${ALPHABET}]{${GROUP}}-[${ALPHABET}]{${GROUP}}$`).test(
    normalizeRoomCode(raw),
  );
}
