/**
 * Lado de lectura.
 *
 * Separado de los comandos porque tiene otro consumidor (el adaptador HTTP, y
 * mañana la UI web) y otras garantías: no muta nada, así que puede servirse
 * desde una réplica o cachearse sin tocar el lado de escritura.
 */

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
