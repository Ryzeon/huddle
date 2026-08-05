import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PROTOCOL_VERSION } from './index.js';
import { validateClientMessage, validateProof, ValidationError } from './validate.js';

const join = (extra: Record<string, unknown>) =>
  validateClientMessage({
    t: 'join',
    v: PROTOCOL_VERSION,
    room: 'BCDFG-HJKMN',
    alias: '@ana',
    quotaRemaining: null,
    ...extra,
  });

describe('validación de frontera', () => {
  test('un tag con salto de línea se rechaza', () => {
    assert.throws(() => join({ tag: 'api\nweb' }));
  });

  test('un tag con espacios se rechaza', () => {
    assert.throws(() => join({ tag: 'Mi Repo' }));
  });

  test('un tag normal pasa y llega en minúsculas', () => {
    const message = join({ tag: 'API' });
    assert.equal(message.t === 'join' ? message.tag : undefined, 'api');
  });

  test('una clave de 42 caracteres no es una clave Ed25519', () => {
    assert.throws(
      () => validateProof({ pubkey: 'a'.repeat(42), sig: 'b'.repeat(86), nonce: 'n' }),
      ValidationError,
    );
  });

  test('una firma de 87 caracteres no es una firma Ed25519', () => {
    assert.throws(
      () => validateProof({ pubkey: 'a'.repeat(43), sig: 'b'.repeat(87), nonce: 'n' }),
      ValidationError,
    );
  });

  test('un nonce fuera de base64url se rechaza', () => {
    assert.throws(
      () => validateProof({ pubkey: 'a'.repeat(43), sig: 'b'.repeat(86), nonce: 'no válido!' }),
      ValidationError,
    );
  });

  test('una prueba bien formada pasa entera', () => {
    const proof = validateProof({
      pubkey: 'a'.repeat(43),
      sig: 'b'.repeat(86),
      nonce: 'abc-_123',
    });
    assert.equal(proof?.nonce, 'abc-_123');
  });

  test('sin prueba no hay error: firmar es opcional', () => {
    assert.equal(validateProof(undefined), undefined);
  });

  test('una sala con aprobación sin firma se rechaza, no se degrada', () => {
    assert.throws(
      () =>
        validateClientMessage({
          t: 'create',
          v: PROTOCOL_VERSION,
          name: 'Equipo',
          alias: '@ana',
          quotaRemaining: null,
          policy: 'approved',
        }),
      ValidationError,
      'degradar a abierta en silencio dejaría una sala que parece cerrada y no lo está',
    );
  });

  test('una sala con aprobación y firma pasa', () => {
    const message = validateClientMessage({
      t: 'create',
      v: PROTOCOL_VERSION,
      name: 'Equipo',
      alias: '@ana',
      quotaRemaining: null,
      policy: 'approved',
      proof: { pubkey: 'a'.repeat(43), sig: 'b'.repeat(86), nonce: 'reto' },
    });
    assert.equal(message.t === 'create' ? message.policy : undefined, 'approved');
  });

  test('una política desconocida se lee como abierta', () => {
    const message = validateClientMessage({
      t: 'create',
      v: PROTOCOL_VERSION,
      name: 'Equipo',
      alias: '@ana',
      quotaRemaining: null,
      policy: 'lo-que-sea',
    });
    assert.equal(message.t === 'create' ? message.policy : undefined, undefined);
  });

  test('admitir exige el id de la solicitud', () => {
    assert.throws(() => validateClientMessage({ t: 'admit' }), ValidationError);
  });

  test('un motivo de error desconocido cae en agent_failed', () => {
    const message = validateClientMessage({ t: 'error', id: 'x', reason: 'inventado' });
    assert.equal(message.t === 'error' ? message.reason : undefined, 'agent_failed');
  });

  test('identity_mismatch es un motivo de error válido', () => {
    const message = validateClientMessage({ t: 'error', id: 'x', reason: 'identity_mismatch' });
    assert.equal(message.t === 'error' ? message.reason : undefined, 'identity_mismatch');
  });
});
