/**
 * Puerto de transporte del portal.
 *
 * Las vistas se suscriben a un `RoomFeed` sin saber si detrás hay un WebSocket
 * o un guion en memoria. Lo implementan `WsRoomFeed` y `DemoRoomFeed`, y quién
 * de los dos se usa lo decide el composition root.
 */

import type {
  AskMessage,
  ChatMessage,
  CreateRoomMessage,
  JoinMessage,
  KickMessage,
} from '@huddle/protocol';
import type { PortalEvent } from '../../domain/session-state.js';

/** Lo que el portal es capaz de mandar. Un espectador no manda `result`. */
export type PortalClientMessage =
  | JoinMessage
  | CreateRoomMessage
  | AskMessage
  | ChatMessage
  | KickMessage;

export interface RoomFeed {
  /** Abre el transporte. Idempotente. */
  start(): void;
  /** Lo cierra para siempre; no reconecta. */
  stop(): void;
  /** Manda un mensaje. Si no hay canal abierto, se descarta en silencio. */
  send(message: PortalClientMessage): void;
  subscribe(listener: (event: PortalEvent) => void): () => void;
}

/** Cómo se identifica el portal al entrar. */
export interface FeedIdentity {
  /** `join` a una sala existente, o `create` de una nueva. */
  mode: 'join' | 'create';
  /** Código de la sala. Vacío cuando se va a crear. */
  room: string;
  /** Nombre legible de la sala nueva. Solo en `create`. */
  roomName?: string;
  alias: string;
  /** Espectador: mira, pregunta si quiere, pero no responde. */
  viewer: boolean;
}

/**
 * Una sala que el portal recuerda. Es memoria del navegador, no estado del
 * hub: el hub solo sabe a cuál estás conectado ahora.
 */
export interface RememberedRoom {
  code: string;
  name: string;
  alias: string;
  hub: string;
  lastSeen: number;
}

export interface RoomsStore {
  list(): RememberedRoom[];
  remember(room: RememberedRoom): void;
  forget(code: string): void;
}
