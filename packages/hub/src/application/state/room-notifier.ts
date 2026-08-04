/**
 * Envío de mensajes a los miembros de una sala.
 *
 * Los handlers no tocan canales directamente: piden aquí. Concentrar el envío
 * en un solo colaborador es lo que garantiza que el `from` se etiquete siempre
 * igual — perderlo es lo que hace ilegible un `@all`.
 */

import type { Alias, ServerMessage } from '@huddle/protocol';
import type { Room } from '../../domain/room.js';
import type { RoomRegistry } from './room-registry.js';
import type {
  ChunkMessage,
  ErrorMessage,
  ResultMessage,
  TraceMessage,
} from '@huddle/protocol';

/** Mensajes que se reenvían del que responde al que preguntó. */
export type RelayableMessage = ChunkMessage | TraceMessage | ResultMessage | ErrorMessage;

export class RoomNotifier {
  constructor(private readonly registry: RoomRegistry) {}

  toChannel(channelId: string, message: ServerMessage): void {
    this.registry.channel(channelId)?.send(message);
  }

  broadcast(room: Room, message: ServerMessage): void {
    for (const member of room.members) {
      this.registry.channel(member.channelId)?.send(message);
    }
  }

  broadcastRoster(room: Room): void {
    this.broadcast(room, { t: 'room_state', members: room.roster() });
  }

  /**
   * Reenvía al autor de la pregunta, etiquetando quién responde.
   * Sin `from`, en un `@all` no hay forma de saber quién está hablando.
   */
  toAsker(room: Room, message: RelayableMessage, from?: Alias): void {
    const asker = room.askerOf(message.id);
    if (!asker) return;
    this.toChannel(asker.channelId, from ? { ...message, from } : message);
  }
}
