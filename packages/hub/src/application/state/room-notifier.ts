import type { Alias, ServerMessage } from '@huddle/protocol';
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

  toAsker(room: Room, message: RelayableMessage, from?: Alias): void {
    const asker = room.askerOf(message.id);
    if (!asker) return;
    this.toChannel(asker.channelId, from ? { ...message, from } : message);
  }
}
