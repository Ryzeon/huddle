export type IdentityDecision =
  /** Nadie ha firmado ese alias y quien llega tampoco firma. */
  | { kind: 'anonymous' }
  /** Primer firmante de un alias libre: se le ata la clave a la sala. */
  | { kind: 'bind'; pubkey: string }
  /** Firma con la misma clave que ya tenía el alias. */
  | { kind: 'known'; pubkey: string }
  /** Firma, pero el alias es de otra clave. */
  | { kind: 'impostor'; bound: string; offered: string }
  /** El alias está firmado y quien llega no trae firma. */
  | { kind: 'squatter'; bound: string };

/**
 * Quién puede usar un alias en una sala.
 *
 * TOFU: el primero que firma un alias se lo queda mientras viva la sala. No
 * hay autoridad ni registro previo, y esa es la única razón de que valga la
 * pena: nadie tiene que dar de alta nada para que @ana siga siendo @ana.
 */
export function decideIdentity(
  bound: string | undefined,
  offered: string | undefined,
): IdentityDecision {
  if (!bound) return offered ? { kind: 'bind', pubkey: offered } : { kind: 'anonymous' };
  if (!offered) return { kind: 'squatter', bound };
  return bound === offered
    ? { kind: 'known', pubkey: bound }
    : { kind: 'impostor', bound, offered };
}
