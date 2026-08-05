import { generateKeyPairSync, createPrivateKey, sign, type KeyObject } from 'node:crypto';
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HUDDLE_DIR, ensureHuddleDir } from './config.js';
import type { IdentitySigner } from './application/ports/index.js';

export const IDENTITY_PATH = join(HUDDLE_DIR, 'identity.json');

interface StoredIdentity {
  /** JWK privada Ed25519. La pública se deriva de ella. */
  key: { kty: string; crv: string; x: string; d: string };
}

/**
 * La clave con la que este agente firma su alias.
 *
 * Se crea una vez y se queda. Un archivo corrupto lanza en vez de regenerar:
 * una clave nueva te echa de todas las salas donde ya firmaste, y hacerlo en
 * silencio convierte un problema de disco en un misterio.
 */
export function loadOrCreateIdentity(path = IDENTITY_PATH): IdentitySigner {
  ensureHuddleDir();

  if (existsSync(path)) return signerFrom(readIdentity(path));

  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const jwk = privateKey.export({ format: 'jwk' }) as StoredIdentity['key'];
  const pub = publicKey.export({ format: 'jwk' }) as { x: string };
  write(path, { key: { ...jwk, x: pub.x } });

  return build(privateKey, pub.x);
}

function readIdentity(path: string): StoredIdentity {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(
      `${path} no se puede leer. NO lo borres a la ligera: una clave nueva te deja ` +
        'fuera de los alias que ya firmaste. Restaura tu copia o elige otro alias.',
    );
  }

  const key = (parsed as Partial<StoredIdentity>)?.key;
  if (!key || typeof key.d !== 'string' || typeof key.x !== 'string' || key.crv !== 'Ed25519') {
    throw new Error(`${path} no contiene una clave Ed25519 válida`);
  }
  return { key: key as StoredIdentity['key'] };
}

function signerFrom(stored: StoredIdentity): IdentitySigner {
  const privateKey = createPrivateKey({ key: stored.key, format: 'jwk' });
  return build(privateKey, stored.key.x);
}

function build(privateKey: KeyObject, publicKey: string): IdentitySigner {
  return {
    publicKey,
    sign: (text) => sign(null, Buffer.from(text, 'utf8'), privateKey).toString('base64url'),
  };
}

/** Temporal + rename: un corte a media escritura no deja media clave en disco. */
function write(path: string, identity: StoredIdentity): void {
  const temp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, path);
  } catch (error) {
    if (existsSync(temp)) {
      try {
        unlinkSync(temp);
      } catch {
        /* nada que hacer */
      }
    }
    throw error;
  }
}
