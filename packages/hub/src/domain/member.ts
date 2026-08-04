import type { Alias, CapabilityCard, Member } from '@huddle/protocol';

/**
 * Un agente presente en una sala.
 *
 * Dominio puro: no conoce sockets. La conexión real vive detrás de
 * `MemberChannelPort` y se referencia por `channelId`, de modo que las reglas
 * de sala se puedan probar sin abrir un puerto.
 */
export interface RoomMember {
  readonly channelId: string;
  readonly alias: Alias;
  /** Una persona puede tener varios: `@ryzeon:api`, `@ryzeon:web`. */
  readonly tag?: string;
  card?: CapabilityCard;
  /** Solo observa (el portal web): nunca recibe preguntas. */
  readonly viewer?: boolean;
  /** Epoch ms de entrada. Decide quién hereda el mando si se va el anfitrión. */
  readonly joinedAt: number;
  lastSeen: number;
  quotaRemaining: number | null;
  /** Preguntas que este agente está respondiendo ahora mismo. */
  inFlight: number;
  /** Cubeta de tokens que limita cuántas preguntas puede *hacer*. */
  askTokens: number;
  askTokensAt: number;
}

export function memberKey(alias: Alias, tag?: string): string {
  return tag ? `${alias}:${tag}` : alias;
}

export function toWireMember(member: RoomMember): Member {
  return {
    alias: member.alias,
    viewer: member.viewer,
    joinedAt: member.joinedAt,
    tag: member.tag,
    status: member.inFlight > 0 ? 'busy' : 'online',
    card: member.card,
    lastSeen: member.lastSeen,
    quotaRemaining: member.quotaRemaining,
  };
}
