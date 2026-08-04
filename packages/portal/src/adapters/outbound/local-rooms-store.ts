import type { RememberedRoom, RoomsStore } from '../../application/ports/room-feed.js';

const KEY = 'huddle.portal.salas.v1';
const MAX_ROOMS = 12;

export class LocalRoomsStore implements RoomsStore {
  constructor(private readonly storage: Storage = localStorage) {}

  list(): RememberedRoom[] {
    return this.read().sort((a, b) => b.lastSeen - a.lastSeen);
  }

  remember(room: RememberedRoom): void {
    const rest = this.read().filter((item) => item.code !== room.code);
    this.write([room, ...rest].slice(0, MAX_ROOMS));
  }

  forget(code: string): void {
    this.write(this.read().filter((item) => item.code !== code));
  }

  private read(): RememberedRoom[] {
    let raw: string | null = null;
    try {
      raw = this.storage.getItem(KEY);
    } catch {
      return []; // navegación privada con almacenamiento bloqueado
    }
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter(isRoom) : [];
    } catch {
      return [];
    }
  }

  private write(rooms: RememberedRoom[]): void {
    try {
      this.storage.setItem(KEY, JSON.stringify(rooms));
    } catch {
      // Sin almacenamiento el portal sigue funcionando; solo no recuerda.
    }
  }
}

function isRoom(value: unknown): value is RememberedRoom {
  if (typeof value !== 'object' || value === null) return false;
  const room = value as Partial<RememberedRoom>;
  return (
    typeof room.code === 'string' &&
    typeof room.name === 'string' &&
    typeof room.alias === 'string' &&
    typeof room.hub === 'string' &&
    typeof room.lastSeen === 'number'
  );
}

export class MemoryRoomsStore implements RoomsStore {
  private rooms: RememberedRoom[];

  constructor(initial: readonly RememberedRoom[] = []) {
    this.rooms = [...initial];
  }

  list(): RememberedRoom[] {
    return [...this.rooms].sort((a, b) => b.lastSeen - a.lastSeen);
  }

  remember(room: RememberedRoom): void {
    this.rooms = [room, ...this.rooms.filter((item) => item.code !== room.code)];
  }

  forget(code: string): void {
    this.rooms = this.rooms.filter((item) => item.code !== code);
  }
}
