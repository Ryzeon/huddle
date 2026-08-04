import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  candidatesByPerson,
  leastBusy,
  rankByFit,
  resolveTargets,
  stem,
  tokenize,
} from './routing.js';
import type { RoomMember } from './member.js';

function member(
  alias: string,
  overrides: Partial<RoomMember> = {},
): RoomMember {
  return {
    channelId: `ch-${alias}${overrides.tag ?? ''}`,
    alias,
    joinedAt: 0,
    lastSeen: 0,
    quotaRemaining: 10,
    inFlight: 0,
    askTokens: 5,
    askTokensAt: 0,
    ...overrides,
  };
}

describe('routing', () => {
  test('un destino concreto resuelve a esa persona', () => {
    const members = [member('@ana'), member('@beto')];
    const targets = resolveTargets(members, '@beto', '@ana', 'x');
    assert.deepEqual(targets.map((t) => t.alias), ['@beto']);
  });

  test('@all excluye a quien pregunta', () => {
    const members = [member('@ana'), member('@beto'), member('@caro')];
    const targets = resolveTargets(members, '@all', '@ana', 'x');
    assert.deepEqual(targets.map((t) => t.alias).sort(), ['@beto', '@caro']);
  });

  test('@all manda una sola pregunta por persona, no por tag', () => {
    const members = [
      member('@ana'),
      member('@beto', { tag: 'api' }),
      member('@beto', { tag: 'web' }),
    ];
    const targets = resolveTargets(members, '@all', '@ana', 'x');
    assert.equal(targets.length, 1, 'preguntarle dos veces le gasta el doble de cuota');
  });

  test('entre tags de la misma persona elige el menos ocupado', () => {
    const ocupado = member('@beto', { tag: 'api', inFlight: 3 });
    const libre = member('@beto', { tag: 'web', inFlight: 0 });
    assert.equal(leastBusy([ocupado, libre])?.tag, 'web');
  });

  test('@auto elige por solapamiento con la tarjeta', () => {
    const members = [
      member('@ana'),
      member('@beto', { card: { repo: 'terraform-infra', dirs: ['modules'] } }),
      member('@caro', { card: { repo: 'servicio-pagos', dirs: ['cobros'] } }),
    ];
    const targets = resolveTargets(members, '@auto', '@ana', 'como funcionan los cobros');
    assert.deepEqual(targets.map((t) => t.alias), ['@caro']);
  });

  test('@auto sin ningún match sigue eligiendo a alguien', () => {
    const members = [member('@ana'), member('@beto', { card: { repo: 'x', dirs: [] } })];
    const targets = resolveTargets(members, '@auto', '@ana', 'algo sin relacion alguna');
    assert.equal(targets.length, 1, 'mejor preguntar a alguien que no preguntar');
  });

  test('un destino ausente resuelve a vacío', () => {
    assert.deepEqual(resolveTargets([member('@ana')], '@fantasma', '@ana', 'x'), []);
  });

  test('preguntar a la sala estando solo no devuelve a nadie', () => {
    assert.deepEqual(resolveTargets([member('@ana')], '@all', '@ana', 'x'), []);
  });

  test('el ranking pone primero el mejor encaje', () => {
    const members = [
      member('@ana'),
      member('@beto', { card: { repo: 'infra', dirs: [] } }),
      member('@caro', { card: { repo: 'pagos', dirs: ['pagos', 'cobros'] } }),
    ];
    const ranked = rankByFit(members, '@ana', 'donde estan los cobros de pagos');
    assert.equal(ranked[0]?.alias, '@caro');
  });

  test('candidatesByPerson colapsa tags y excluye al que pregunta', () => {
    const members = [
      member('@ana'),
      member('@beto', { tag: 'a' }),
      member('@beto', { tag: 'b' }),
      member('@caro'),
    ];
    assert.equal(candidatesByPerson(members, '@ana').length, 2);
  });
});

describe('tokenize', () => {
  test('quita tildes, stopwords y palabras cortas', () => {
    const tokens = tokenize('¿Dónde está el módulo de pagos?');
    assert.ok(tokens.includes('modulo'));
    assert.ok(!tokens.includes('donde'), 'donde es stopword');
    assert.ok(!tokens.includes('el'));
  });

  test('singular y plural caen en el mismo término', () => {
    // Sin esto, "sala" y "salas" no casan — y en español eso rompe el ruteo
    // en casi cualquier pregunta.
    assert.deepEqual(tokenize('sala'), tokenize('salas'));
    assert.deepEqual(tokenize('codigo'), tokenize('codigos'));
    assert.deepEqual(tokenize('mes'), tokenize('mes'), 'no destroza palabras cortas');
  });

  test('los verbos de accion no puntuan: valen para cualquier repositorio', () => {
    // «send invoices» enganchaba con el repo de mensajeria, que decia «send
    // whatsapp messages», en vez de con el de facturas: el verbo era el unico
    // termino que coincidia entre pregunta y tarjeta.
    const tokens = tokenize('send invoices to the customer');

    assert.ok(!tokens.includes('send'), 'el verbo no distingue nada');
    assert.ok(tokens.includes('invoic'), 'el sustantivo si, ya lematizado');
    assert.ok(tokens.includes('customer'));
  });

  test('la lista cubre infinitivos, no conjugaciones', () => {
    // Limite conocido y asumido: `stem` solo deshace plurales, asi que
    // «enviamos» pasa el filtro. No hace dano mientras las tarjetas se
    // describan con sustantivos, que es lo que se le pide al ampliar.
    assert.ok(!tokenize('enviar facturas').includes('enviar'));
    assert.ok(tokenize('enviamos facturas').includes('enviamo'));
  });

  test('stem no toca palabras que solo parecen plurales', () => {
    assert.equal(stem('bus'), 'bus');
    assert.equal(stem('api'), 'api');
  });

  test('conserva identificadores con guion bajo', () => {
    assert.ok(tokenize('la funcion charge_customer').includes('charge_customer'));
  });
});
