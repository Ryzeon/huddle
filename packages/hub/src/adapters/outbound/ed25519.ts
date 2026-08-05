import { createPublicKey, randomBytes, verify } from 'node:crypto';
import type { NoncePort, SignatureVerifierPort } from '../../application/ports/member-channel.js';

/**
 * Verificación de firmas Ed25519 con lo que ya trae node.
 *
 * Todo va en try/catch porque `createPublicKey` lanza ante material
 * malformado, y aquí el material siempre viene de fuera: una clave con basura
 * es una firma que no valida, no una excepción que tumba el hub.
 */
export const ed25519Verifier: SignatureVerifierPort = {
  verify(pubkey: string, text: string, sig: string): boolean {
    try {
      const key = createPublicKey({
        key: { kty: 'OKP', crv: 'Ed25519', x: pubkey },
        format: 'jwk',
      });
      return verify(null, Buffer.from(text, 'utf8'), key, Buffer.from(sig, 'base64url'));
    } catch {
      return false;
    }
  },
};

export const randomNonces: NoncePort = {
  next: () => randomBytes(16).toString('base64url'),
};
