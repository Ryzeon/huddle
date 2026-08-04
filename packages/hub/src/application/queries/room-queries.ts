import type { TranscriptEntry } from '../../domain/room.js';
import type { RoomRegistry } from '../state/room-registry.js';

export interface HubStats {
  rooms: number;
  members: number;
}

export class RoomQueries {
  constructor(private readonly registry: RoomRegistry) {}

  transcript(roomCode: string): readonly TranscriptEntry[] {
    return this.registry.roomByCode(roomCode)?.transcript ?? [];
  }

  stats(): HubStats {
    return {
      rooms: this.registry.countRooms(),
      members: this.registry.countMembers(),
    };
  }
}
