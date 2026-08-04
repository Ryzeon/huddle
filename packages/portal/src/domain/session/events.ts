import type { ActivityMessage, Alias, Member, SourceRef } from '@huddle/protocol';
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
  reason: 'kicked' | 'empty';
  detail?: string;
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

export type PortalEvent =
  | TransportEvent
  | NoteEvent
  | WelcomeEvent
  | RoomStateEvent
  | HostChangedEvent
  | RoomClosedEvent
  | ChatEvent
  | ActivityMessage
  | ResultEvent
  | ErrorEvent;
