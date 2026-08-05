import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPublicKey, verify } from 'node:crypto';
import { identityProofText } from '@huddle/protocol';
import { loadOrCreateIdentity } from './identity.js';

describe('la clave del agente', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'huddle-identity-'));
    path = join(dir, 'identity.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('se crea la primera vez y luego se reutiliza', () => {
    const primera = loadOrCreateIdentity(path);
    const segunda = loadOrCreateIdentity(path);

    assert.equal(primera.publicKey, segunda.publicKey, 'una clave nueva te echaría de tus salas');
  });

  test('la clave pública tiene la forma que espera el protocolo', () => {
    const identity = loadOrCreateIdentity(path);
    assert.equal(identity.publicKey.length, 43);
    assert.match(identity.publicKey, /^[A-Za-z0-9_-]+$/);
  });

  test('la firma tiene la forma que espera el protocolo', () => {
    const identity = loadOrCreateIdentity(path);
    const sig = identity.sign('lo que sea');
    assert.equal(sig.length, 86);
    assert.match(sig, /^[A-Za-z0-9_-]+$/);
  });

  test('el archivo solo lo puede leer su dueño', () => {
    loadOrCreateIdentity(path);
    // En Windows los permisos POSIX no aplican y el modo no es significativo.
    if (process.platform === 'win32') return;
    assert.equal(statSync(path).mode & 0o777, 0o600);
  });

  test('un archivo corrupto falla en vez de regenerar la clave en silencio', () => {
    writeFileSync(path, 'esto no es json');
    assert.throws(() => loadOrCreateIdentity(path), /no se puede leer/);
  });

  test('un archivo sin clave Ed25519 tampoco se regenera solo', () => {
    writeFileSync(path, JSON.stringify({ key: { kty: 'RSA' } }));
    assert.throws(() => loadOrCreateIdentity(path), /Ed25519/);
  });

  test('la clave privada no se pierde al releerla del disco', () => {
    const primera = loadOrCreateIdentity(path);
    const firmaOriginal = primera.sign('mismo texto');

    const releida = loadOrCreateIdentity(path);
    assert.equal(releida.sign('mismo texto'), firmaOriginal, 'Ed25519 es determinista');
  });

  test('lo que firma el agente lo verifica el hub', () => {
    const identity = loadOrCreateIdentity(path);
    const text = identityProofText({
      kind: 'join',
      room: 'BCDFG-HJKMN',
      alias: '@ana',
      tag: 'api',
      viewer: false,
      nonce: 'un-reto',
    });

    // Exactamente lo que hace `ed25519Verifier` en el hub, con la clave que el
    // agente publica. Es el único test que ata los dos lados.
    const key = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: identity.publicKey },
      format: 'jwk',
    });
    const valida = verify(
      null,
      Buffer.from(text, 'utf8'),
      key,
      Buffer.from(identity.sign(text), 'base64url'),
    );

    assert.equal(valida, true);
  });

  test('la clave privada no se escribe en claro fuera del archivo de identidad', () => {
    const identity = loadOrCreateIdentity(path);
    const raw = readFileSync(path, 'utf8');
    assert.match(raw, /"d":/, 'la privada vive ahí, y solo ahí');
    assert.equal(
      Object.keys(identity).includes('privateKey'),
      false,
      'el firmante no expone la privada, solo firma con ella',
    );
  });
});
