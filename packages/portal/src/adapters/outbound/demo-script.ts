/**
 * Guion del modo demo: entran tres, se cruzan preguntas, una sale de caché,
 * otra falla, alguien se va y el mando cambia de manos. Permite ajustar las
 * animaciones sin depender del hub.
 *
 * Son datos puros, una lista de `{ at, event }` en milisegundos desde el
 * arranque. Reproducirlo es cosa de `DemoRoomFeed`; separarlos deja el guion
 * comprobable y hace trivial escribir otro.
 */

import type { Member } from '@huddle/protocol';
import type { PortalEvent } from '../../domain/session-state.js';
import type { RememberedRoom } from '../../application/ports/room-feed.js';

export interface ScriptedEvent {
  /** Milisegundos desde que arranca la reproducción. */
  at: number;
  event: PortalEvent;
}

export const DEMO_ROOM = 'MPP8V-7HZS5';
export const DEMO_ROOM_NAME = 'plataforma';
export const DEMO_YOU = '@visita';

const T0 = 1_735_729_200_000; // instante ficticio y estable: los tests no bailan

function member(
  alias: string,
  joinedAtOffset: number,
  repo: string,
  dirs: string[],
  options: { tag?: string; quotaRemaining?: number | null; status?: Member['status'] } = {},
): Member {
  const value: Member = {
    alias,
    joinedAt: T0 + joinedAtOffset,
    status: options.status ?? 'online',
    lastSeen: T0 + joinedAtOffset,
    quotaRemaining: options.quotaRemaining ?? 17,
    card: { repo, dirs },
  };
  if (options.tag !== undefined) value.tag = options.tag;
  return value;
}

const ana = member('@ana', 0, 'plataforma-core', ['src/auth', 'src/billing']);
const bruno = member('@bruno', 1200, 'gateway-api', ['src/http', 'src/routing'], { tag: 'api' });
const carla = member('@carla', 2000, 'facturacion', ['src/tax', 'src/invoices'], {
  tag: 'facturacion',
  quotaRemaining: 4,
});
/** El portal entra como espectador: mira y puede preguntar, pero no responde. */
const you: Member = {
  alias: DEMO_YOU,
  joinedAt: T0 - 200,
  status: 'online',
  lastSeen: T0,
  quotaRemaining: null,
  viewer: true,
};

/** Una sesión de principio a fin, en poco más de veinte segundos. */
export const DEMO_SCRIPT: ScriptedEvent[] = [
  { at: 0, event: { t: 'transport', status: 'connecting' } },
  {
    at: 450,
    event: {
      t: 'welcome',
      v: 1,
      room: DEMO_ROOM,
      roomName: DEMO_ROOM_NAME,
      you: DEMO_YOU,
      host: '@ana',
      members: [you, ana],
    },
  },
  { at: 1500, event: { t: 'room_state', members: [you, ana, bruno] } },
  { at: 2600, event: { t: 'room_state', members: [you, ana, bruno, carla] } },
  {
    at: 3400,
    event: { t: 'msg', from: '@ana', text: '¿alguien sabe dónde se valida el IVA de las facturas?' },
  },
  { at: 4200, event: { t: 'activity', id: 'q1', from: '@bruno', to: '@carla', phase: 'asking' } },
  {
    at: 7900,
    event: { t: 'activity', id: 'q1', from: '@bruno', to: '@carla', phase: 'answered', elapsedMs: 3680 },
  },
  {
    at: 8600,
    event: { t: 'msg', from: '@carla', text: 'está en src/tax/vat.ts, lo dejé documentado arriba' },
  },
  { at: 9600, event: { t: 'activity', id: 'q2', from: '@ana', to: '@bruno', phase: 'asking' } },
  {
    at: 10400,
    event: {
      t: 'activity',
      id: 'q2',
      from: '@ana',
      to: '@bruno',
      phase: 'answered',
      elapsedMs: 690,
      cached: true,
    },
  },
  { at: 11600, event: { t: 'activity', id: 'q3', from: '@carla', to: '@ana', phase: 'asking' } },
  {
    at: 15800,
    event: { t: 'activity', id: 'q3', from: '@carla', to: '@ana', phase: 'failed', elapsedMs: 4200 },
  },
  {
    at: 16600,
    event: { t: 'msg', from: '@bruno', text: '@ana se le acabó la cuota de hoy, pregúntame a mí' },
  },
  { at: 18000, event: { t: 'room_state', members: [you, bruno, carla] } },
  { at: 18200, event: { t: 'host_changed', host: '@bruno', reason: 'left' } },
  { at: 19400, event: { t: 'activity', id: 'q4', from: '@carla', to: '@bruno', phase: 'asking' } },
  {
    at: 22600,
    event: { t: 'activity', id: 'q4', from: '@carla', to: '@bruno', phase: 'answered', elapsedMs: 3180 },
  },
  {
    at: 23400,
    event: { t: 'note', text: 'fin del guion de demostración: pulsa «repetir» para verlo otra vez', tone: 'system' },
  },
];

/** Cuánto dura el guion entero. */
export function scriptDuration(script: readonly ScriptedEvent[] = DEMO_SCRIPT): number {
  return script.reduce((max, item) => Math.max(max, item.at), 0);
}

/** Los miembros que el guion llega a mostrar, para el autocompletado inicial. */
export const DEMO_MEMBERS: Member[] = [you, ana, bruno, carla];

/**
 * Salas de mentira para el lateral. En demo no se toca `localStorage`: mirar
 * la demostración no debe dejar rastro en el navegador.
 */
export const DEMO_ROOMS: RememberedRoom[] = [
  { code: DEMO_ROOM, name: DEMO_ROOM_NAME, alias: DEMO_YOU, hub: 'ws://localhost:8787', lastSeen: T0 },
  { code: 'JX4T2-9QW1M', name: 'infra', alias: DEMO_YOU, hub: 'ws://localhost:8787', lastSeen: T0 - 86_400_000 },
  { code: 'B7KD0-3RNC6', name: 'incidencias', alias: DEMO_YOU, hub: 'ws://localhost:8787', lastSeen: T0 - 259_200_000 },
];
