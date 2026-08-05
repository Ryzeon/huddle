import type {
  ActivityMessage,
  Alias,
  CapabilityCard,
  FolderEntry,
  FolderWrite,
  Member,
  SourceRef,
} from '@huddle/protocol';
import type { ConnectionStatus } from './state.js';

export interface TransportEvent {
  t: 'transport';
  status: ConnectionStatus;
  detail?: string;
}

export interface NoteEvent {
  t: 'note';
  text: string;
  tone?: 'system' | 'failed';
}

export interface WelcomeEvent {
  t: 'welcome';
  v: number;
  room: string;
  roomName: string;
  you: Alias;
  host: Alias;
  members: Member[];
}

export interface RoomStateEvent {
  t: 'room_state';
  members: Member[];
}

export interface HostChangedEvent {
  t: 'host_changed';
  host: Alias;
  reason: 'left' | 'created' | 'returned';
}

export interface RoomClosedEvent {
  t: 'room_closed';
  reason: 'kicked' | 'empty' | 'closed_by_host' | 'code_rotated' | 'identity_taken';
  detail?: string;
}

export interface RoomCodeEvent {
  t: 'room_code';
  id: string;
  room: string;
  previous: string;
  by: Alias;
}

export interface WaitingApprovalEvent {
  t: 'waiting_approval';
  id: string;
  room: string;
  roomName: string;
  you: Alias;
  host: Alias;
  key: string;
}

export interface JoinRequestEvent {
  t: 'join_request';
  id: string;
  alias: Alias;
  tag?: string;
  key: string;
  card?: CapabilityCard;
  at: number;
  knownAlias?: Alias;
}

export interface JoinRequestGoneEvent {
  t: 'join_request_gone';
  id: string;
  reason: 'resolved' | 'left' | 'expired' | 'room_closed';
}

export interface ChatEvent {
  t: 'msg';
  from: Alias;
  text: string;
}

export interface ResultEvent {
  t: 'result';
  id: string;
  from?: Alias;
  answer: string;
  sources: SourceRef[];
  confidence: 'low' | 'medium' | 'high';
  elapsedMs: number;
  cached: boolean;
}

export interface ErrorEvent {
  t: 'error';
  id: string;
  from?: Alias;
  reason: string;
  detail?: string;
}

export interface FolderStateEvent {
  t: 'folder_state';
  entries: FolderEntry[];
  write: FolderWrite;
}

export interface FolderFileEvent {
  t: 'folder_file';
  id: string;
  path: string;
  text: string;
  at: number;
}

/** Acuse de una escritura propia: es lo que cierra el editor abierto. */
export interface FolderOkEvent {
  t: 'folder_ok';
  id: string;
  path: string;
}

export type PortalEvent =
  | TransportEvent
  | NoteEvent
  | WelcomeEvent
  | RoomStateEvent
  | HostChangedEvent
  | RoomClosedEvent
  | RoomCodeEvent
  | WaitingApprovalEvent
  | JoinRequestEvent
  | JoinRequestGoneEvent
  | ChatEvent
  | ActivityMessage
  | ResultEvent
  | ErrorEvent
  | FolderStateEvent
  | FolderFileEvent
  | FolderOkEvent;
