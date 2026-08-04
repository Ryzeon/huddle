import { randomInt } from 'node:crypto';

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

export function normalizeRoomCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, '');
}

export function isValidRoomCode(raw: string): boolean {
  return new RegExp(`^[${ALPHABET}]{${GROUP}}-[${ALPHABET}]{${GROUP}}$`).test(
    normalizeRoomCode(raw),
  );
}
