import type { ActivityMessage, Member } from '@huddle/protocol';
import { memberLabel } from '../table-layout.js';
import { describeAnswer, describeFailure, errorText } from './format.js';
import type {
  HostChangedEvent,
  PortalEvent,
  RoomClosedEvent,
  RoomStateEvent,
  TransportEvent,
  WelcomeEvent,
} from './events.js';
import {
  ACTIVITY_TTL_MS,
  appendEntry,
  type Activity,
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
      return appendEntry(state, now, {
        kind: 'failed',
        alias: event.from ?? undefined,
        text: errorText(event.reason),
        meta: event.detail ?? undefined,
      });
    default:
      return state;
  }
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

function onRoomClosed(state: SessionState, event: RoomClosedEvent, now: number): SessionState {
  const kicked = event.reason === 'kicked';
  const next: SessionState = { ...state, status: 'closed', closed: true, members: [] };
  if (event.detail !== undefined) next.detail = event.detail;

  return appendEntry(next, now, {
    kind: kicked ? 'kicked' : 'system',
    alias: state.you ?? undefined,
    text: kicked ? 'te expulsaron de la sala' : 'la sala se cerró',
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
