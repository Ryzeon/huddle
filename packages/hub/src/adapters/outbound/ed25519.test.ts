import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { ed25519Verifier, randomNonces } from './ed25519.js';

function newIdentity(): { pubkey: string; sign: (text: string) => string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string };
  return {
    pubkey: jwk.x,
    sign: (text) => sign(null, Buffer.from(text, 'utf8'), privateKey).toString('base64url'),
  };
}

describe('verificación Ed25519', () => {
  test('una firma real valida', () => {
    const identity = newIdentity();
    const texto = 'huddle-identity-v1\njoin\nBCDFG-HJKMN\n@ana\n\n0\nnonce';
    assert.equal(ed25519Verifier.verify(identity.pubkey, texto, identity.sign(texto)), true);
  });

  test('una firma sobre otro texto no vale', () => {
    const identity = identityFor('un texto');
    assert.equal(ed25519Verifier.verify(identity.pubkey, 'otro texto', identity.sig), false);
  });

  test('una firma manipulada no vale', () => {
    const identity = identityFor('un texto');
    const roto = `${identity.sig.slice(0, -2)}${identity.sig.endsWith('AA') ? 'BB' : 'AA'}`;
    assert.equal(ed25519Verifier.verify(identity.pubkey, 'un texto', roto), false);
  });

  test('la firma de otra clave no vale', () => {
    const ana = identityFor('un texto');
    const beto = newIdentity();
    assert.equal(ed25519Verifier.verify(beto.pubkey, 'un texto', ana.sig), false);
  });

  test('una clave con basura devuelve false sin lanzar', () => {
    assert.doesNotThrow(() => ed25519Verifier.verify('basura', 'texto', 'firma'));
    assert.equal(ed25519Verifier.verify('basura', 'texto', 'firma'), false);
    assert.equal(ed25519Verifier.verify('', '', ''), false);
  });
});

describe('nonces', () => {
  test('no se repiten', () => {
    const vistos = new Set<string>();
    for (let i = 0; i < 500; i++) vistos.add(randomNonces.next());
    assert.equal(vistos.size, 500);
  });

  test('caben en el límite del protocolo y son base64url', () => {
    const nonce = randomNonces.next();
    assert.ok(nonce.length <= 64);
    assert.match(nonce, /^[A-Za-z0-9_-]+$/);
  });
});

function identityFor(text: string): { pubkey: string; sig: string } {
  const identity = newIdentity();
  return { pubkey: identity.pubkey, sig: identity.sign(text) };
}
