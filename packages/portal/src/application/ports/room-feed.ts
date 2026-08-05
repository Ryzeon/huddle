import type {
  AdmitGuestMessage,
  AskMessage,
  CloseRoomMessage,
  DenyGuestMessage,
  ChatMessage,
  CreateRoomMessage,
  JoinMessage,
  KickMessage,
  RotateCodeMessage,
} from '@huddle/protocol';
import type { PortalEvent } from '../../domain/session-state.js';

export type PortalClientMessage =
  | JoinMessage
  | CreateRoomMessage
  | AskMessage
  | ChatMessage
  | KickMessage
  | RotateCodeMessage
  | AdmitGuestMessage
  | DenyGuestMessage
  | CloseRoomMessage;

export interface RoomFeed {
  /** Abre el transporte. Idempotente. */
  start(): void;
  stop(): void;
  /** Manda un mensaje. Si no hay canal abierto, se descarta en silencio. */
  send(message: PortalClientMessage): void;
  subscribe(listener: (event: PortalEvent) => void): () => void;
}

export interface FeedIdentity {
  mode: 'join' | 'create';
  room: string;
  roomName?: string;
  alias: string;
  viewer: boolean;
  /** Solo al crear, y solo si se puede firmar. */
  policy?: 'approved';
}

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
