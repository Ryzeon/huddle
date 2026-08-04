/**
 * Estado compartido del hub: qué salas existen y qué canal es cada miembro.
 *
 * Los handlers no guardan estado; lo piden aquí. Concentrarlo en un solo sitio
 * evita que cada comando invente su propio `Map` y se desincronicen (que es
 * exactamente el bug que tenía el servidor original con sus mapas sueltos a
 * nivel de módulo).
 */

import { Room } from '../../domain/room.js';
import type { BucketPolicy } from '../../domain/rate-limit.js';
import type { MemberChannelPort } from '../ports/member-channel.js';

export class RoomRegistry {
  private readonly rooms = new Map<string, Room>();
  private readonly channels = new Map<string, MemberChannelPort>();
  /** En qué sala está cada canal, para resolver sin recorrer todas. */
  private readonly roomOfChannel = new Map<string, string>();

  constructor(private readonly askPolicy: BucketPolicy) {}

  /**
   * Vuelve a poner en pie salas guardadas en disco.
   *
   * Quedan vacías pero con su código vivo: entrar mañana con el mismo código
   * es lo que hace que el historial sirva de algo.
   */
  restore(records: { code: string; name: string; createdAt: number }[]): void {
    for (const record of records) {
      if (this.rooms.has(record.code)) continue;
      this.rooms.set(
        record.code,
        new Room(record.code, record.name, this.askPolicy, record.createdAt),
      );
    }
  }

  /** Lo mínimo para reconstruirlas al arrancar. */
  snapshot(): { code: string; name: string; createdAt: number }[] {
    return [...this.rooms.values()].map((room) => ({
      code: room.code,
      name: room.name,
      createdAt: room.createdAt,
    }));
  }

  forget(code: string): void {
    this.rooms.delete(code);
  }

  /**
   * Crea una sala con nombre y un código único. Reintenta ante una colisión
   * improbable en vez de sobrescribir una sala viva.
   */
  createRoom(name: string, generateCode: () => string, now: number): Room {
    let code = generateCode();
    for (let attempt = 0; attempt < 5 && this.rooms.has(code); attempt++) {
      code = generateCode();
    }
    if (this.rooms.has(code)) throw new Error('no se pudo generar un código libre');

    const room = new Room(code, name, this.askPolicy, now);
    this.rooms.set(code, room);
    return room;
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

  /**
   * Una sala vacía y sin historial no vale la pena conservar.
   *
   * Si tiene historial se queda dormida: su código sigue sirviendo mañana, y
   * es la purga por antigüedad la que acaba cerrándola cuando ya no le queda
   * memoria que justificar.
   */
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
