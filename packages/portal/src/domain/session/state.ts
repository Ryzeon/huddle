import type {
  ActivityMessage,
  Alias,
  FolderEntry,
  FolderWrite,
  Member,
  SourceRef,
} from '@huddle/protocol';
import { memberLabel } from '../table-layout.js';

export type ConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'online'
  | 'offline'
  | 'closed'
  /** En la puerta: el hub te oyó, pero todavía no estás dentro. */
  | 'waiting';

export interface PendingGuest {
  id: string;
  alias: Alias;
  tag?: string;
  key: string;
  repo?: string;
  at: number;
  knownAlias?: Alias;
}

export interface WaitingInfo {
  id: string;
  roomName: string;
  host: Alias;
  /** Tu propia cola de clave, para poder dictársela al anfitrión. */
  key: string;
}

export type ActivityPhase = ActivityMessage['phase'];

export type EntryKind =
  | 'system'
  | 'joined'
  | 'left'
  | 'kicked'
  | 'host'
  | 'message'
  | 'ask'
  | 'answer'
  | 'failed';

export interface LogEntry {
  id: string;
  at: number;
  kind: EntryKind;
  alias?: string;
  target?: string;
  text?: string;
  meta?: string;
  sources?: SourceRef[];
}

export interface Activity {
  id: string;
  from: Alias;
  to: Alias;
  phase: ActivityPhase;
  startedAt: number;
  endedAt?: number;
  elapsedMs?: number;
  cached?: boolean;
}

export interface SessionState {
  status: ConnectionStatus;
  detail?: string;
  room: string | null;
  roomName: string | null;
  you: Alias | null;
  host: Alias | null;
  members: Member[];
  entries: LogEntry[];
  activities: Activity[];
  busy: string[];
  closed: boolean;
  seq: number;
  /** Quién espera a entrar. Solo se llena si eres el anfitrión. */
  pending: PendingGuest[];
  /** Puesto si eres tú quien espera. */
  waitingInfo: WaitingInfo | null;
  /** La carpeta de la sala, sin contenidos: se piden de uno en uno. */
  folder: FolderEntry[];
  folderWrite: FolderWrite;
  /** El archivo abierto en el visor, o el que se está esperando. */
  folderOpen: OpenFile | null;
}

export interface OpenFile {
  path: string;
  /** Ausente mientras el hub no ha contestado todavía. */
  text?: string;
}

export const MAX_ENTRIES = 400;

export const ACTIVITY_TTL_MS = 6_000;

export function initialState(): SessionState {
  return {
    status: 'idle',
    room: null,
    roomName: null,
    you: null,
    host: null,
    members: [],
    entries: [],
    activities: [],
    busy: [],
    closed: false,
    seq: 0,
    pending: [],
    waitingInfo: null,
    folder: [],
    folderWrite: 'all',
    folderOpen: null,
  };
}

export function mentionables(state: SessionState): string[] {
  return [...state.members.map(memberLabel), '@all', '@auto'];
}

export function isHost(state: SessionState, label: string): boolean {
  return state.host !== null && (label === state.host || label.startsWith(`${state.host}:`));
}

// El id sale del contador del propio estado: sin reloj ni aleatoriedad, para
// que el reductor siga siendo puro.
export function appendEntry(
  state: SessionState,
  now: number,
  entry: Omit<LogEntry, 'id' | 'at'>,
): SessionState {
  const seq = state.seq + 1;
  const entries = [...state.entries, { id: `e${seq}`, at: now, ...entry }];
  return {
    ...state,
    seq,
    entries: entries.length > MAX_ENTRIES ? entries.slice(-MAX_ENTRIES) : entries,
  };
}
