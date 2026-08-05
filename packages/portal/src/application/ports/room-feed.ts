import type {
  AdmitGuestMessage,
  AskMessage,
  CloseRoomMessage,
  DenyGuestMessage,
  ChatMessage,
  CreateRoomMessage,
  FolderDropMessage,
  FolderGetMessage,
  FolderPutMessage,
  FolderPutManyMessage,
  FolderWrite,
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
  | CloseRoomMessage
  | FolderPutMessage
  | FolderPutManyMessage
  | FolderDropMessage
  | FolderGetMessage;

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
  /** Solo al crear: quién escribe en la carpeta de la sala. */
  folderWrite?: FolderWrite;
  /** Solo al crear: si las respuestas se quedan escritas en la carpeta. */
  folderMemory?: boolean;
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
