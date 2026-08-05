import type { RoomRecord } from '../ports/member-channel.js';
import { Room } from '../../domain/room.js';
import type { BucketPolicy } from '../../domain/rate-limit.js';
import type { MemberChannelPort } from '../ports/member-channel.js';

export class RoomRegistry {
  private readonly rooms = new Map<string, Room>();
  private readonly channels = new Map<string, MemberChannelPort>();
  private readonly roomOfChannel = new Map<string, string>();

  constructor(private readonly askPolicy: BucketPolicy) {}

  restore(records: RoomRecord[]): void {
    for (const record of records) {
      if (this.rooms.has(record.code)) continue;
      const room = new Room(record.code, record.name, this.askPolicy, record.createdAt);
      if (record.owner) room.restoreOwner(record.owner);
      this.rooms.set(record.code, room);
    }
  }

  snapshot(): RoomRecord[] {
    return [...this.rooms.values()].map((room) => {
      const record: RoomRecord = {
        code: room.code,
        name: room.name,
        createdAt: room.createdAt,
      };
      if (room.ownerAlias) record.owner = room.ownerAlias;
      return record;
    });
  }

  forget(code: string): void {
    this.rooms.delete(code);
  }

  /**
   * Un código que no esté en uso. Reintenta ante una colisión improbable en
   * vez de sobrescribir una sala viva.
   */
  freeCode(generateCode: () => string): string {
    let code = generateCode();
    for (let attempt = 0; attempt < 5 && this.rooms.has(code); attempt++) {
      code = generateCode();
    }
    if (this.rooms.has(code)) throw new Error('no se pudo generar un código libre');
    return code;
  }

  createRoom(name: string, generateCode: () => string, now: number): Room {
    const code = this.freeCode(generateCode);
    const room = new Room(code, name, this.askPolicy, now);
    this.rooms.set(code, room);
    return room;
  }

  /**
   * Reindexa la sala bajo un código nuevo.
   *
   * Hay que mover también `roomOfChannel`: si no, el propio anfitrión se queda
   * apuntando a un código que ya no existe y el hub le contesta que mande
   * `join` primero.
   */
  recode(room: Room, next: string): void {
    const previous = room.code;
    this.rooms.delete(previous);
    room.rotateCode(next);
    this.rooms.set(next, room);

    for (const [channelId, code] of this.roomOfChannel) {
      if (code === previous) this.roomOfChannel.set(channelId, next);
    }
  }

  roomByCode(code: string): Room | undefined {
    return this.rooms.get(code);
  }

  roomOf(channelId: string): Room | undefined {
    const code = this.roomOfChannel.get(channelId);
    return code ? this.rooms.get(code) : undefined;
  }

  allRooms(): Room[] {
    return [...this.rooms.values()];
  }

  channel(channelId: string): MemberChannelPort | undefined {
    return this.channels.get(channelId);
  }

  attach(channel: MemberChannelPort, roomCode: string): void {
    this.channels.set(channel.id, channel);
    this.roomOfChannel.set(channel.id, roomCode);
  }

  detach(channelId: string): void {
    this.channels.delete(channelId);
    this.roomOfChannel.delete(channelId);
  }

  dropIfExhausted(room: Room): void {
    if (room.isEmpty && room.transcript.length === 0) {
      this.rooms.delete(room.code);
    }
  }

  countMembers(): number {
    let total = 0;
    for (const room of this.rooms.values()) total += room.members.length;
    return total;
  }

  countRooms(): number {
    return this.rooms.size;
  }
}
