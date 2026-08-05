import { identityProofText, type IdentityProof, type IdentityProofInput } from '@huddle/protocol';
import type { SignatureVerifierPort } from '../ports/member-channel.js';
import type { Challenges } from '../state/challenges.js';

export interface IdentityCheck {
  channelId: string;
  proof?: IdentityProof;
  context: Omit<IdentityProofInput, 'nonce'>;
}

export interface IdentityCheckDeps {
  challenges: Challenges;
  verifier: SignatureVerifierPort;
}

/**
 * La clave con la que quien llega ha demostrado firmar, o nada.
 *
 * El reto se gasta pase lo que pase: dejarlo vivo tras un intento fallido
 * daría barra libre para probar firmas contra el mismo nonce.
 *
 * Una firma que no valida se trata como si no hubiera firma. No pierde nada:
 * quien no firma solo entra donde el alias está libre.
 */
export function verifiedKey(
  { challenges, verifier }: IdentityCheckDeps,
  { channelId, proof, context }: IdentityCheck,
): string | undefined {
  const nonce = challenges.take(channelId);
  if (!proof || !nonce) return undefined;

  // El nonce lo puso el hub para ESTA conexión: una prueba capturada de otra
  // sesión trae el suyo, y no es el que se está esperando aquí.
  if (proof.nonce !== nonce) return undefined;

  let text: string;
  try {
    text = identityProofText({ ...context, nonce });
  } catch {
    return undefined;
  }

  return verifier.verify(proof.pubkey, text, proof.sig) ? proof.pubkey : undefined;
}
