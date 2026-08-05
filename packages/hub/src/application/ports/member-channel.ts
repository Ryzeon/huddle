import type { ServerMessage } from '@huddle/protocol';
import type { TranscriptEntry } from '../../domain/room.js';

export interface TranscriptStorePort {
  append(roomCode: string, roomName: string, entry: TranscriptEntry): void;
  read(roomCode: string): TranscriptEntry[];
  purge(roomCode: string, cutoff: number): number;
  /** Falso si el destino ya existe: pisarlo perdería el historial de otra sala. */
  rename(from: string, to: string): boolean;
}

export interface ApprovedGuest {
  key: string;
  alias: string;
  at: number;
}

export interface RoomRecord {
  code: string;
  name: string;
  createdAt: number;
  /** Quien la creó. Sin esto, reiniciar el hub le quitaría la sala a su dueño. */
  owner?: string;
  /** Alias vinculados a una clave pública, por sala. */
  keys?: Record<string, string>;
  policy?: 'open' | 'approved';
  /** Clave del dueño: es lo que le devuelve la sala tras un reinicio. */
  ownerKey?: string;
  approved?: ApprovedGuest[];
}

export interface NoncePort {
  next(): string;
}

export interface SignatureVerifierPort {
  verify(pubkey: string, text: string, sig: string): boolean;
}

export interface RoomStorePort {
  readAll(): RoomRecord[];
  writeAll(rooms: RoomRecord[]): void;
}

export interface MemberChannelPort {
  readonly id: string;
  send(message: ServerMessage): void;
  close(code: number, reason: string): void;
}

export interface ClockPort {
  now(): number;
}

export const systemClock: ClockPort = { now: () => Date.now() };

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
