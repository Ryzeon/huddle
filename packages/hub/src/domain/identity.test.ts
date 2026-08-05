import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { decideIdentity } from './identity.js';

const ANA = 'clave-de-ana';
const BETO = 'clave-de-beto';

describe('quién puede usar un alias', () => {
  test('un alias libre y sin firma entra sin más', () => {
    assert.deepEqual(decideIdentity(undefined, undefined), { kind: 'anonymous' });
  });

  test('el primero que firma un alias libre se lo queda', () => {
    assert.deepEqual(decideIdentity(undefined, ANA), { kind: 'bind', pubkey: ANA });
  });

  test('volver con la misma clave es volver a ser el mismo', () => {
    assert.deepEqual(decideIdentity(ANA, ANA), { kind: 'known', pubkey: ANA });
  });

  test('firmar el alias de otro es suplantarlo', () => {
    assert.deepEqual(decideIdentity(ANA, BETO), {
      kind: 'impostor',
      bound: ANA,
      offered: BETO,
    });
  });

  test('un alias firmado no lo ocupa quien llega sin firma', () => {
    assert.deepEqual(decideIdentity(ANA, undefined), { kind: 'squatter', bound: ANA });
  });
});
