import type { ActivityMessage, Member } from '@huddle/protocol';
import { memberLabel } from '../table-layout.js';
import { describeAnswer, describeFailure, errorText } from './format.js';
import type {
  ErrorEvent,
  FolderStateEvent,
  HostChangedEvent,
  JoinRequestEvent,
  JoinRequestGoneEvent,
  PortalEvent,
  RoomClosedEvent,
  RoomCodeEvent,
  RoomStateEvent,
  TransportEvent,
  WaitingApprovalEvent,
  WelcomeEvent,
} from './events.js';
import {
  ACTIVITY_TTL_MS,
  appendEntry,
  type Activity,
  type PendingGuest,
  type SessionState,
} from './state.js';

export function reduce(state: SessionState, event: PortalEvent, now: number): SessionState {
  switch (event.t) {
    case 'transport':
      return onTransport(state, event, now);
    case 'note':
      return appendEntry(state, now, {
        kind: event.tone === 'failed' ? 'failed' : 'system',
        text: event.text,
      });
    case 'welcome':
      return onWelcome(state, event, now);
    case 'room_state':
      return onRoomState(state, event, now);
    case 'host_changed':
      return onHostChanged(state, event, now);
    case 'room_closed':
      return onRoomClosed(state, event, now);
    case 'room_code':
      return onRoomCode(state, event, now);
    case 'waiting_approval':
      return onWaitingApproval(state, event, now);
    case 'join_request':
      return onJoinRequest(state, event, now);
    case 'join_request_gone':
      return onJoinRequestGone(state, event);
    case 'msg':
      return appendEntry(state, now, { kind: 'message', alias: event.from, text: event.text });
    case 'activity':
      return onActivity(state, event, now);
    case 'result':
      return appendEntry(state, now, {
        kind: 'answer',
        alias: event.from ?? '@?',
        text: event.answer,
        meta: describeAnswer(event.elapsedMs, event.cached, event.confidence),
        sources: event.sources,
      });
    case 'error':
      return onError(state, event, now);
    case 'folder_state':
      return onFolderState(state, event);
    case 'folder_file':
      // Llega la respuesta a un `folder_get`. Si mientras tanto se abrió otro
      // archivo, esta ya no interesa: pintarla sería reemplazar lo que se está
      // mirando por lo que se dejó de mirar.
      return state.folderOpen?.path === event.path
        ? { ...state, folderOpen: { path: event.path, text: event.text } }
        : state;
    case 'folder_ok':
      return state;
    default:
      return state;
  }
}

function onError(state: SessionState, event: ErrorEvent, now: number): SessionState {
  const next = appendEntry(state, now, {
    kind: 'failed',
    alias: event.from ?? undefined,
    text: errorText(event.reason),
    meta: event.detail ?? undefined,
  });

  // Un error mientras se esperaba un archivo deja el visor cargando para
  // siempre. Se cierra: el motivo ya se ve en el registro de la sesión.
  return state.folderOpen && state.folderOpen.text === undefined
    ? { ...next, folderOpen: null }
    : next;
}

/**
 * La carpeta llega entera en cada cambio, así que se reemplaza sin comparar.
 *
 * Lo que sí se mira es el archivo abierto: si ya no está en la carpeta, se lo
 * han borrado a todo el mundo mientras alguien lo leía, y dejarlo en pantalla
 * sería enseñar algo que ya no existe.
 */
function onFolderState(state: SessionState, event: FolderStateEvent): SessionState {
  const open = state.folderOpen;
  const sigue = open && event.entries.some((entry) => entry.path === open.path);

  return {
    ...state,
    folder: event.entries,
    folderWrite: event.write,
    folderOpen: sigue ? open : null,
  };
}

export function pruneActivities(state: SessionState, now: number): SessionState {
  const kept = state.activities.filter(
    (activity) =>
      activity.phase === 'asking' ||
      now - (activity.endedAt ?? activity.startedAt) < ACTIVITY_TTL_MS,
  );
  return kept.length === state.activities.length ? state : { ...state, activities: kept };
}

function onTransport(state: SessionState, event: TransportEvent, now: number): SessionState {
  if (state.status === event.status && !event.detail) return state;

  const next: SessionState = { ...state, status: event.status };
  if (event.detail !== undefined) next.detail = event.detail;
  else delete next.detail;

  if (event.status === 'offline') {
    return appendEntry(next, now, { kind: 'system', text: 'se perdió la conexión con el hub' });
  }
  if (event.status === 'connecting' && state.status === 'offline') {
    return appendEntry(next, now, { kind: 'system', text: 'reconectando…' });
  }
  return next;
}

function onWelcome(state: SessionState, event: WelcomeEvent, now: number): SessionState {
  const next: SessionState = {
    ...state,
    status: 'online',
    room: event.room,
    roomName: event.roomName,
    you: event.you,
    host: event.host,
    members: [...event.members],
    closed: false,
    // Si venías de la puerta, ya estás dentro.
    waitingInfo: null,
  };
  delete next.detail;

  return appendEntry(next, now, {
    kind: 'system',
    text: `entraste a «${event.roomName}» como ${event.you}`,
    meta: event.room,
  });
}

// Se compara por etiqueta completa (`@ana:api`) y no por alias: una persona
// puede tener varios repos en la sala, y cada uno es un nodo distinto.
function onRoomState(state: SessionState, event: RoomStateEvent, now: number): SessionState {
  const before = new Set(state.members.map(memberLabel));
  const after = new Set(event.members.map(memberLabel));

  let next: SessionState = { ...state, members: [...event.members] };

  for (const member of event.members) {
    const label = memberLabel(member);
    if (before.has(label)) continue;
    next = appendEntry(next, now, { kind: 'joined', alias: label, meta: repoOf(member) });
  }

  for (const member of state.members) {
    const label = memberLabel(member);
    if (after.has(label)) continue;
    next = appendEntry(next, now, { kind: 'left', alias: label });
  }

  return next;
}

function onHostChanged(state: SessionState, event: HostChangedEvent, now: number): SessionState {
  const next: SessionState = { ...state, host: event.host };
  if (state.host === event.host) return next;

  return appendEntry(next, now, {
    kind: 'host',
    alias: event.host,
    meta: HOST_REASON[event.reason],
  });
}

function onRoomCode(state: SessionState, event: RoomCodeEvent, now: number): SessionState {
  const next: SessionState = { ...state, room: event.room };
  return appendEntry(next, now, {
    kind: 'system',
    text: `${event.by} cambió el código de la sala`,
    meta: event.room,
  });
}

function onWaitingApproval(
  state: SessionState,
  event: WaitingApprovalEvent,
  now: number,
): SessionState {
  const next: SessionState = {
    ...state,
    status: 'waiting',
    room: event.room,
    roomName: event.roomName,
    you: event.you,
    host: event.host,
    members: [],
    closed: false,
    waitingInfo: {
      id: event.id,
      roomName: event.roomName,
      host: event.host,
      key: event.key,
    },
  };
  delete next.detail;

  return appendEntry(next, now, {
    kind: 'system',
    text: `esperando a que ${event.host} te deje entrar en «${event.roomName}»`,
    meta: event.key ? `tu clave: …${event.key}` : 'entras sin firmar',
  });
}

function onJoinRequest(state: SessionState, event: JoinRequestEvent, now: number): SessionState {
  const guest: PendingGuest = {
    id: event.id,
    alias: event.alias,
    tag: event.tag,
    key: event.key,
    repo: event.card?.repo,
    at: event.at,
    knownAlias: event.knownAlias,
  };

  // Dedupe por id: con varios repos, la misma solicitud llega varias veces.
  const pending = [...state.pending.filter((p) => p.id !== event.id), guest];
  const yaEstaba = state.pending.some((p) => p.id === event.id);
  const next: SessionState = { ...state, pending };
  if (yaEstaba) return next;

  return appendEntry(next, now, {
    kind: 'system',
    text: `${event.alias} pide entrar`,
    meta: `clave …${event.key}`,
  });
}

function onJoinRequestGone(state: SessionState, event: JoinRequestGoneEvent): SessionState {
  const pending = state.pending.filter((p) => p.id !== event.id);
  return pending.length === state.pending.length ? state : { ...state, pending };
}

const CLOSED_TEXT: Record<RoomClosedEvent['reason'], string> = {
  kicked: 'te expulsaron de la sala',
  // La sala sigue en pie: decir que se cerró mandaría a buscar una sala que
  // existe, con un código que ya no es el suyo.
  code_rotated: 'el anfitrión cambió el código; pídele el nuevo para volver',
  identity_taken: 'ese alias lo reclamó quien lo tenía firmado',
  empty: 'la sala se cerró',
  closed_by_host: 'la sala se cerró',
};

function onRoomClosed(state: SessionState, event: RoomClosedEvent, now: number): SessionState {
  const kicked = event.reason === 'kicked';
  const next: SessionState = { ...state, status: 'closed', closed: true, members: [] };
  if (event.detail !== undefined) next.detail = event.detail;

  return appendEntry(next, now, {
    kind: kicked ? 'kicked' : 'system',
    alias: state.you ?? undefined,
    text: CLOSED_TEXT[event.reason] ?? 'la sala se cerró',
    meta: event.detail ?? undefined,
  });
}

function onActivity(state: SessionState, event: ActivityMessage, now: number): SessionState {
  return event.phase === 'asking' ? startActivity(state, event, now) : endActivity(state, event, now);
}

function startActivity(state: SessionState, event: ActivityMessage, now: number): SessionState {
  const activity: Activity = {
    id: event.id,
    from: event.from,
    to: event.to,
    phase: 'asking',
    startedAt: now,
  };

  const next: SessionState = {
    ...state,
    activities: [...withoutActivity(state, event.id), activity],
    busy: [...new Set([...state.busy, event.to])],
  };

  return appendEntry(next, now, { kind: 'ask', alias: event.from, target: event.to });
}

function endActivity(state: SessionState, event: ActivityMessage, now: number): SessionState {
  const previous = state.activities.find((candidate) => candidate.id === event.id);

  const activity: Activity = {
    id: event.id,
    from: previous?.from ?? event.from,
    to: previous?.to ?? event.to,
    phase: event.phase,
    startedAt: previous?.startedAt ?? now,
    endedAt: now,
  };
  if (event.elapsedMs !== undefined) activity.elapsedMs = event.elapsedMs;
  if (event.cached !== undefined) activity.cached = event.cached;

  // Solo deja de estar ocupado si no le queda otra pregunta en vuelo.
  const stillBusy = state.activities.some(
    (candidate) =>
      candidate.id !== event.id && candidate.phase === 'asking' && candidate.to === activity.to,
  );

  const next: SessionState = {
    ...state,
    activities: [...withoutActivity(state, event.id), activity],
    busy: stillBusy ? state.busy : state.busy.filter((alias) => alias !== activity.to),
  };

  const answered = event.phase === 'answered';
  return appendEntry(next, now, {
    kind: answered ? 'answer' : 'failed',
    alias: activity.to,
    target: activity.from,
    meta: answered
      ? describeAnswer(event.elapsedMs, event.cached)
      : describeFailure(event.elapsedMs),
  });
}

function withoutActivity(state: SessionState, id: string): Activity[] {
  return state.activities.filter((activity) => activity.id !== id);
}

const HOST_REASON: Record<HostChangedEvent['reason'], string> = {
  left: 'heredó el mando',
  created: 'creó la sala',
  returned: 'volvió y recuperó el mando',
};

function repoOf(member: Member): string | undefined {
  return member.card?.repo;
}
