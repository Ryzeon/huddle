import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAuto, scoreMember, tokenize } from './routing.js';
import type { RoomMember } from './member.js';

function member(alias: string, card: RoomMember['card'], inFlight = 0): RoomMember {
  return {
    channelId: `ch-${alias}`,
    alias,
    joinedAt: 0,
    lastSeen: 0,
    quotaRemaining: 10,
    inFlight,
    askTokens: 5,
    askTokensAt: 0,
    card,
  };
}

const facturacion = member('@ana', {
  repo: 'repo-api',
  dirs: ['src', 'src/billing', 'src/cobros'],
  summary: 'Servicio de facturación y cobros a clientes.',
  keywords: ['spring', 'jpa', 'billing-service'],
});

const salas = member('@beto', {
  repo: 'huddle',
  dirs: ['packages', 'packages/hub', 'packages/protocol'],
  summary: 'Salas donde el agente de cada quien responde a sus compañeros.',
  keywords: ['websocket', 'huddle', 'typescript'],
});

/**
 * El caso que motivó esto: una pregunta sobre códigos de sala se enrutó al
 * repositorio de facturación porque ninguna tarjeta encajaba y el desempate
 * era "quién está menos ocupado" — o sea, al azar. Una respuesta segura desde
 * el repositorio equivocado es peor que admitir que no se sabe.
 */
describe('resolveAuto', () => {
  test('acierta cuando la pregunta usa el vocabulario del repo', () => {
    const out = resolveAuto([facturacion, salas], '@zoe', 'como se cobran los clientes');
    assert.deepEqual(out.targets.map((t) => t.alias), ['@ana']);
  });

  test('acierta con el otro repositorio igual de bien', () => {
    const out = resolveAuto([facturacion, salas], '@zoe', 'como funciona el websocket del hub');
    assert.deepEqual(out.targets.map((t) => t.alias), ['@beto']);
  });

  test('engancha por directorio de segundo nivel', () => {
    // `billing` solo aparece en `src/billing`: sin segundo nivel no habría señal.
    const out = resolveAuto([facturacion, salas], '@zoe', 'donde esta el modulo billing');
    assert.deepEqual(out.targets.map((t) => t.alias), ['@ana']);
  });

  test('NO elige cuando ninguna tarjeta encaja', () => {
    const out = resolveAuto([facturacion, salas], '@zoe', 'que desayunaste hoy amigo');
    assert.deepEqual(out.targets, []);
    assert.equal(out.reason, 'ambiguous', 'preferimos no saber a acertar por casualidad');
  });

  test('con un solo candidato va para él aunque no encaje', () => {
    const out = resolveAuto([facturacion], '@zoe', 'algo sin ninguna relacion');
    assert.deepEqual(out.targets.map((t) => t.alias), ['@ana'], 'no hay nada que decidir');
  });

  test('sin nadie a quien preguntar lo dice distinto', () => {
    const out = resolveAuto([], '@zoe', 'lo que sea');
    assert.equal(out.reason, 'no_members');
  });

  test('nunca se elige a quien pregunta', () => {
    const out = resolveAuto([facturacion], '@ana', 'como se cobran los clientes');
    assert.equal(out.reason, 'no_members');
  });

  test('a igualdad de encaje sobre el MISMO repo, gana el menos ocupado', () => {
    const ocupado = member('@caro', facturacion.card, 3);
    const libre = member('@dani', facturacion.card, 0);
    const out = resolveAuto([ocupado, libre], '@zoe', 'cobros a clientes');
    assert.deepEqual(out.targets.map((t) => t.alias), ['@dani'], 'cualquiera sabe responder');
  });

  test('a igualdad de encaje entre repos DISTINTOS, no elige', () => {
    // Aqui el desempate por ocupacion elegiria de que trata la pregunta, que
    // no es algo que la ocupacion sepa. Con tarjetas ampliadas los empates a
    // un termino son mas frecuentes, asi que se admite antes que se adivina.
    const uno = member('@caro', { repo: 'cobros', dirs: ['src/pagos'] }, 3);
    const otro = member('@dani', { repo: 'tesoreria', dirs: ['src/pagos'] }, 0);
    const out = resolveAuto([uno, otro], '@zoe', 'donde esta el modulo de pagos');
    assert.deepEqual(out.targets, []);
    assert.equal(out.reason, 'ambiguous');
  });
});

describe('varios repositorios de una misma persona', () => {
  /**
   * El bug que motivó esta prueba: los repositorios de una persona se
   * colapsaban a uno solo (por "menos ocupado") ANTES de puntuar, así que
   * `@auto` elegía al azar entre ellos y luego puntuaba lo que le tocara.
   */
  const devFacturacion: RoomMember = { ...facturacion, alias: '@dev', channelId: 'ch-dev-fact', tag: 'facturacion' };
  const devSalas: RoomMember = { ...salas, alias: '@dev', channelId: 'ch-dev-salas', tag: 'salas' };

  test('elige el repositorio correcto de la misma persona', () => {
    const out = resolveAuto([devFacturacion, devSalas], '@zoe', 'como se cobran los clientes');
    assert.equal(out.targets[0]?.tag, 'facturacion');
  });

  test('y el otro cuando la pregunta cambia', () => {
    const out = resolveAuto([devFacturacion, devSalas], '@zoe', 'problema con el websocket del hub');
    assert.equal(out.targets[0]?.tag, 'salas');
  });

  test('el repositorio ocupado gana igual si encaja mejor', () => {
    const ocupado = { ...devFacturacion, inFlight: 5 };
    const out = resolveAuto([ocupado, devSalas], '@zoe', 'cobros a clientes de facturación');
    assert.equal(out.targets[0]?.tag, 'facturacion', 'el encaje manda sobre la ocupación');
  });
});

describe('scoreMember', () => {
  test('las keywords del manifiesto suman', () => {
    const terms = tokenize('problema con websocket');
    assert.ok(scoreMember(salas, terms) > 0);
    assert.equal(scoreMember(facturacion, terms), 0);
  });

  test('una tarjeta vacía nunca puntúa', () => {
    const vacio = member('@x', { repo: '', dirs: [] });
    assert.equal(scoreMember(vacio, tokenize('cualquier cosa')), 0);
  });
});
