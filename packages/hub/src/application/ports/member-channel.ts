import type { ServerMessage } from '@huddle/protocol';
import type { TranscriptEntry } from '../../domain/room.js';

/**
 * Historial de sesiones. Sobrevive al cierre de la sala a propósito: es la
 * memoria del equipo, no un buffer de la conexión.
 */
export interface TranscriptStorePort {
  append(roomCode: string, roomName: string, entry: TranscriptEntry): void;
  read(roomCode: string): TranscriptEntry[];
  /**
   * Borra las entradas anteriores a `cutoff` y devuelve cuántas quedan.
   * Cero significa que a esa sala ya no le queda memoria que justificar.
   */
  purge(roomCode: string, cutoff: number): number;
}

/** Lo mínimo para resucitar una sala tras reiniciar el hub. */
export interface RoomRecord {
  code: string;
  name: string;
  createdAt: number;
}

export interface RoomStorePort {
  readAll(): RoomRecord[];
  writeAll(rooms: RoomRecord[]): void;
}

/**
 * Puerto de salida: por dónde le habla el hub a un miembro.
 *
 * Modela una capacidad ("mandarle un mensaje a este miembro"), no una
 * tecnología. La implementación real es un WebSocket; en los tests es un array.
 */
export interface MemberChannelPort {
  readonly id: string;
  send(message: ServerMessage): void;
  close(code: number, reason: string): void;
}

/** Reloj como puerto: ningún caso de uso llama a `Date.now()` directamente. */
export interface ClockPort {
  now(): number;
}

export const systemClock: ClockPort = { now: () => Date.now() };

/**
 * Temporizadores como puerto, para que los tests puedan disparar un timeout
 * sin esperar de verdad.
 */
export interface TimerPort {
  schedule(delayMs: number, task: () => void): CancelTimer;
}

export type CancelTimer = () => void;

export const systemTimers: TimerPort = {
  schedule(delayMs, task) {
    const handle = setTimeout(task, delayMs);
    return () => clearTimeout(handle);
  },
};
