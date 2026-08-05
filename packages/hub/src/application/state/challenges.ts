import type { NoncePort } from '../ports/member-channel.js';

/** Tope de retos vivos. Cada uno son unas decenas de bytes; el techo es contra abuso. */
const MAX_CHALLENGES = 10_000;

/**
 * Un reto por conexión, de un solo uso.
 *
 * El nonce lo pone el hub, así que una prueba capturada de otra sesión no
 * sirve: al consumirse desaparece, y la conexión siguiente tiene otro.
 */
export class Challenges {
  private readonly byChannel = new Map<string, string>();

  constructor(private readonly nonces: NoncePort) {}

  issue(channelId: string): string {
    if (this.byChannel.size >= MAX_CHALLENGES) {
      const oldest = this.byChannel.keys().next();
      if (!oldest.done) this.byChannel.delete(oldest.value);
    }
    const nonce = this.nonces.next();
    this.byChannel.set(channelId, nonce);
    return nonce;
  }

  /** Devuelve el reto y lo gasta. Un segundo intento no encuentra nada. */
  take(channelId: string): string | undefined {
    const nonce = this.byChannel.get(channelId);
    this.byChannel.delete(channelId);
    return nonce;
  }

  forget(channelId: string): void {
    this.byChannel.delete(channelId);
  }
}
