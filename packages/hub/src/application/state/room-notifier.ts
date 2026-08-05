import { keyTail, type Alias, type ServerMessage } from '@huddle/protocol';
import type { Room } from '../../domain/room.js';
import type { RoomRegistry } from './room-registry.js';
import type {
  ChunkMessage,
  ErrorMessage,
  ResultMessage,
  TraceMessage,
} from '@huddle/protocol';

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

  /** Solo al anfitrión, y a todas sus conexiones: el portero es él. */
  toHost(room: Room, message: ServerMessage): void {
    const host = room.hostAlias;
    if (!host) return;
    for (const channelId of room.channelsOf(host)) this.toChannel(channelId, message);
  }

  /**
   * El backlog de solicitudes pendientes. Quien hereda el mando no vio las que
   * llegaron antes, y sin esto quedarían esperando a nadie hasta caducar.
   */
  sendPendingRequests(room: Room, host: Alias): void {
    for (const channelId of room.channelsOf(host)) {
      for (const guest of room.waitingList()) {
        this.toChannel(channelId, {
          t: 'join_request',
          id: guest.id,
          alias: guest.alias,
          tag: guest.tag,
          key: keyTail(guest.key),
          card: guest.card,
          at: guest.at,
          ...(room.admission.aliasOwner(guest.key) && {
            knownAlias: room.admission.aliasOwner(guest.key),
          }),
        });
      }
    }
  }

  toAsker(room: Room, message: RelayableMessage, from?: Alias): void {
    const asker = room.askerOf(message.id);
    if (!asker) return;
    this.toChannel(asker.channelId, from ? { ...message, from } : message);
  }
}
