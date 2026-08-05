import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Member } from '@huddle/protocol';
import {
  ACTIVITY_TTL_MS,
  MAX_ENTRIES,
  initialState,
  isHost,
  mentionables,
  pruneActivities,
  reduce,
  type PortalEvent,
  type SessionState,
} from './session-state.js';

function member(alias: string, extra: Partial<Member> = {}): Member {
  return {
    alias,
    status: 'online',
    lastSeen: 0,
    quotaRemaining: null,
    ...extra,
  };
}

/** Aplica una secuencia con un reloj que avanza un segundo por evento. */
function run(events: PortalEvent[], from = initialState()): SessionState {
  return events.reduce((state, event, index) => reduce(state, event, 1000 * (index + 1)), from);
}

const WELCOME: PortalEvent = {
  t: 'welcome',
  v: 1,
  room: 'MPP8V-7HZS5',
  roomName: 'plataforma',
  you: '@visita',
  host: '@ana',
  members: [member('@ana', { joinedAt: 1 })],
};

describe('welcome', () => {
  it('deja la sala montada y anota que entraste', () => {
    const state = run([WELCOME]);
    assert.equal(state.status, 'online');
    assert.equal(state.room, 'MPP8V-7HZS5');
    assert.equal(state.roomName, 'plataforma');
    assert.equal(state.you, '@visita');
    assert.equal(state.host, '@ana');
    assert.equal(state.members.length, 1);
    assert.equal(state.entries.at(-1)?.kind, 'system');
    assert.match(state.entries.at(-1)?.text ?? '', /entraste a «plataforma»/);
  });

  it('no anuncia como recién llegados a los que ya estaban', () => {
    const state = run([WELCOME]);
    assert.equal(state.entries.filter((e) => e.kind === 'joined').length, 0);
  });
});

describe('diff del roster', () => {
  it('deduce quién entró', () => {
    const state = run([
      WELCOME,
      { t: 'room_state', members: [member('@ana'), member('@bruno', { card: { repo: 'gateway', dirs: [] } })] },
    ]);
    const joined = state.entries.filter((e) => e.kind === 'joined');
    assert.equal(joined.length, 1);
    assert.equal(joined[0]?.alias, '@bruno');
    assert.equal(joined[0]?.meta, 'gateway');
  });

  it('deduce quién salió', () => {
    const state = run([
      WELCOME,
      { t: 'room_state', members: [member('@ana'), member('@bruno')] },
      { t: 'room_state', members: [member('@bruno')] },
    ]);
    const left = state.entries.filter((e) => e.kind === 'left');
    assert.equal(left.length, 1);
    assert.equal(left[0]?.alias, '@ana');
  });

  it('un roster idéntico no genera ruido', () => {
    const roster: PortalEvent = { t: 'room_state', members: [member('@ana'), member('@bruno')] };
    const once = run([WELCOME, roster]);
    const twice = reduce(once, roster, 9000);
    assert.equal(twice.entries.length, once.entries.length);
  });

  it('distingue los repos de una misma persona', () => {
    const state = run([
      WELCOME,
      { t: 'room_state', members: [member('@ana'), member('@ana', { tag: 'api' })] },
    ]);
    const joined = state.entries.filter((e) => e.kind === 'joined');
    assert.deepEqual(joined.map((e) => e.alias), ['@ana:api']);
  });
});

describe('anfitrión', () => {
  it('anota el cambio de mando', () => {
    const state = run([WELCOME, { t: 'host_changed', host: '@bruno', reason: 'left' }]);
    assert.equal(state.host, '@bruno');
    const entry = state.entries.at(-1);
    assert.equal(entry?.kind, 'host');
    assert.equal(entry?.meta, 'heredó el mando');
  });

  it('reconfirmar el mismo anfitrión no repite la entrada', () => {
    const state = run([WELCOME, { t: 'host_changed', host: '@ana', reason: 'created' }]);
    assert.equal(state.entries.filter((e) => e.kind === 'host').length, 0);
  });

  it('isHost reconoce los tags del anfitrión', () => {
    const state = run([WELCOME]);
    assert.equal(isHost(state, '@ana'), true);
    assert.equal(isHost(state, '@ana:api'), true);
    assert.equal(isHost(state, '@anabel'), false);
  });
});

describe('actividad', () => {
  it('la pregunta deja ocupado al destinatario', () => {
    const state = run([WELCOME, { t: 'activity', id: 'q1', from: '@ana', to: '@bruno', phase: 'asking' }]);
    assert.deepEqual(state.busy, ['@bruno']);
    assert.equal(state.activities.length, 1);
    const entry = state.entries.at(-1);
    assert.equal(entry?.kind, 'ask');
    assert.equal(entry?.alias, '@ana');
    assert.equal(entry?.target, '@bruno');
  });

  it('la respuesta lo libera y anota tiempo y caché', () => {
    const state = run([
      WELCOME,
      { t: 'activity', id: 'q1', from: '@ana', to: '@bruno', phase: 'asking' },
      { t: 'activity', id: 'q1', from: '@ana', to: '@bruno', phase: 'answered', elapsedMs: 690, cached: true },
    ]);
    assert.deepEqual(state.busy, []);
    assert.equal(state.activities[0]?.phase, 'answered');
    assert.equal(state.entries.at(-1)?.meta, '690 ms · caché');
  });

  it('dos preguntas al mismo agente no lo desocupan a medias', () => {
    const state = run([
      WELCOME,
      { t: 'activity', id: 'q1', from: '@ana', to: '@bruno', phase: 'asking' },
      { t: 'activity', id: 'q2', from: '@carla', to: '@bruno', phase: 'asking' },
      { t: 'activity', id: 'q1', from: '@ana', to: '@bruno', phase: 'answered', elapsedMs: 100 },
    ]);
    assert.deepEqual(state.busy, ['@bruno']);
  });

  it('el fallo se marca como tal y también libera', () => {
    const state = run([
      WELCOME,
      { t: 'activity', id: 'q1', from: '@ana', to: '@bruno', phase: 'asking' },
      { t: 'activity', id: 'q1', from: '@ana', to: '@bruno', phase: 'failed', elapsedMs: 4200 },
    ]);
    assert.deepEqual(state.busy, []);
    assert.equal(state.entries.at(-1)?.kind, 'failed');
    assert.equal(state.entries.at(-1)?.meta, '4.2 s · sin respuesta');
  });

  it('una fase final sin su «asking» previo no rompe nada', () => {
    const state = run([
      WELCOME,
      { t: 'activity', id: 'suelto', from: '@ana', to: '@bruno', phase: 'answered', elapsedMs: 10 },
    ]);
    assert.equal(state.activities.length, 1);
    assert.deepEqual(state.busy, []);
  });

  it('las terminadas se limpian al pasar su tiempo; las vivas no', () => {
    const state = run([
      WELCOME,
      { t: 'activity', id: 'q1', from: '@ana', to: '@bruno', phase: 'asking' },
      { t: 'activity', id: 'q1', from: '@ana', to: '@bruno', phase: 'answered', elapsedMs: 1 },
      { t: 'activity', id: 'q2', from: '@ana', to: '@carla', phase: 'asking' },
    ]);
    const later = pruneActivities(state, 4000 + ACTIVITY_TTL_MS);
    assert.deepEqual(later.activities.map((a) => a.id), ['q2']);
    assert.equal(pruneActivities(later, 4000 + ACTIVITY_TTL_MS), later, 'sin cambios, mismo objeto');
  });
});

describe('mensajes y respuestas propias', () => {
  it('el chat humano se guarda tal cual', () => {
    const state = run([WELCOME, { t: 'msg', from: '@ana', text: 'buenas' }]);
    assert.equal(state.entries.at(-1)?.kind, 'message');
    assert.equal(state.entries.at(-1)?.text, 'buenas');
  });

  it('el resultado de tu pregunta sí trae el contenido y las fuentes', () => {
    const state = run([
      WELCOME,
      {
        t: 'result',
        id: 'q1',
        from: '@bruno',
        answer: 'en el puerto 9931',
        sources: [{ file: 'src/server.ts', line: 2 }],
        confidence: 'high',
        elapsedMs: 12000,
        cached: false,
      },
    ]);
    const entry = state.entries.at(-1);
    assert.equal(entry?.kind, 'answer');
    assert.equal(entry?.text, 'en el puerto 9931');
    assert.equal(entry?.meta, '12 s · high');
    assert.deepEqual(entry?.sources, [{ file: 'src/server.ts', line: 2 }]);
  });

  it('los errores del hub se traducen a castellano', () => {
    const state = run([WELCOME, { t: 'error', id: 'q1', reason: 'quota_exceeded', detail: '@bruno' }]);
    assert.equal(state.entries.at(-1)?.text, 'cuota agotada');
    assert.equal(state.entries.at(-1)?.meta, '@bruno');
  });
});

describe('cierre y transporte', () => {
  it('una expulsión cierra la sala y lo dice', () => {
    const state = run([WELCOME, { t: 'room_closed', reason: 'kicked', detail: 'spam' }]);
    assert.equal(state.closed, true);
    assert.equal(state.status, 'closed');
    assert.deepEqual(state.members, []);
    assert.equal(state.entries.at(-1)?.kind, 'kicked');
  });

  it('perder la conexión se anota una sola vez', () => {
    const state = run([WELCOME, { t: 'transport', status: 'offline' }, { t: 'transport', status: 'offline' }]);
    assert.equal(state.entries.filter((e) => e.text === 'se perdió la conexión con el hub').length, 1);
  });

  it('reconectar tras una caída se avisa', () => {
    const state = run([
      WELCOME,
      { t: 'transport', status: 'offline' },
      { t: 'transport', status: 'connecting' },
    ]);
    assert.equal(state.entries.at(-1)?.text, 'reconectando…');
  });
});

describe('cambiar el código de la sala', () => {
  it('el anfitrión ve el código nuevo en la cabecera', () => {
    const state = run([
      WELCOME,
      { t: 'room_code', id: 'r1', room: 'NUEVO-CODIG', previous: 'MPP8V-7HZS5', by: '@ana' },
    ]);
    assert.equal(state.room, 'NUEVO-CODIG');
    assert.equal(state.status, 'online', 'a él no lo echan de ningún lado');
  });

  it('el cambio queda anotado en el hilo con quién lo hizo', () => {
    const state = run([
      WELCOME,
      { t: 'room_code', id: 'r1', room: 'NUEVO-CODIG', previous: 'MPP8V-7HZS5', by: '@ana' },
    ]);
    const ultima = state.entries.at(-1);
    assert.match(ultima?.text ?? '', /@ana/);
    assert.equal(ultima?.meta, 'NUEVO-CODIG');
  });

  it('a quien echan no se le dice que la sala se cerró, porque sigue abierta', () => {
    const state = run([WELCOME, { t: 'room_closed', reason: 'code_rotated' }]);
    assert.equal(state.closed, true);
    assert.doesNotMatch(state.entries.at(-1)?.text ?? '', /se cerró/);
    assert.match(state.entries.at(-1)?.text ?? '', /código/);
  });
});

describe('alias firmado', () => {
  it('te echan porque el alias era de otro, y no se dice que la sala se cerró', () => {
    const state = run([WELCOME, { t: 'room_closed', reason: 'identity_taken' }]);
    assert.equal(state.closed, true);
    assert.doesNotMatch(state.entries.at(-1)?.text ?? '', /se cerró/);
  });

  it('el motivo de identidad se traduce en el hilo', () => {
    const state = run([
      WELCOME,
      { t: 'error', id: 'x', reason: 'identity_mismatch', detail: '…abc12345' },
    ]);
    assert.match(state.entries.at(-1)?.text ?? '', /firmado por otra clave/);
    assert.equal(state.entries.at(-1)?.meta, '…abc12345');
  });
});

describe('la puerta', () => {
  const ESPERA: PortalEvent = {
    t: 'waiting_approval',
    id: 'w1',
    room: 'MPP8V-7HZS5',
    roomName: 'plataforma',
    you: '@visita',
    host: '@ana',
    key: 'abc12345',
  };

  const SOLICITUD: PortalEvent = {
    t: 'join_request',
    id: 'r1',
    alias: '@beto',
    key: 'def67890',
    at: 1_000,
  };

  it('esperar no es estar dentro', () => {
    const state = run([ESPERA]);
    assert.equal(state.status, 'waiting');
    assert.deepEqual(state.members, [], 'todavía no ve a nadie');
    assert.equal(state.waitingInfo?.host, '@ana');
    assert.equal(state.waitingInfo?.key, 'abc12345');
  });

  it('al entrar por fin, la pantalla de espera desaparece', () => {
    const state = run([ESPERA, WELCOME]);
    assert.equal(state.waitingInfo, null);
    assert.equal(state.status, 'online');
  });

  it('el anfitrión ve quién pide entrar, con su clave', () => {
    const state = run([WELCOME, SOLICITUD]);
    assert.equal(state.pending.length, 1);
    assert.equal(state.pending[0]?.alias, '@beto');
    assert.equal(state.pending[0]?.key, 'def67890');
  });

  it('la misma solicitud por varios repos se cuenta una vez', () => {
    const state = run([WELCOME, SOLICITUD, SOLICITUD, SOLICITUD]);
    assert.equal(state.pending.length, 1, 'un repo por conexión, una sola persona');
    assert.equal(
      state.entries.filter((e) => e.text?.includes('pide entrar')).length,
      1,
      'y un solo aviso en el hilo',
    );
  });

  it('resolver una solicitud la quita de la lista', () => {
    const state = run([
      WELCOME,
      SOLICITUD,
      { t: 'join_request_gone', id: 'r1', reason: 'resolved' },
    ]);
    assert.equal(state.pending.length, 0);
  });

  it('retirar una solicitud que no está no cambia el estado', () => {
    const antes = run([WELCOME, SOLICITUD]);
    const despues = reduce(antes, { t: 'join_request_gone', id: 'otra', reason: 'left' }, 9_000);
    assert.equal(despues, antes, 'sin cambios no hay que repintar');
  });

  it('dos personas distintas esperan las dos', () => {
    const state = run([
      WELCOME,
      SOLICITUD,
      { t: 'join_request', id: 'r2', alias: '@caro', key: 'xyz11111', at: 2_000 },
    ]);
    assert.equal(state.pending.length, 2);
  });
});

describe('varios', () => {
  it('los ids de entrada son únicos y crecientes', () => {
    const state = run([WELCOME, { t: 'msg', from: '@ana', text: 'a' }, { t: 'msg', from: '@ana', text: 'b' }]);
    const ids = state.entries.map((e) => e.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.deepEqual(ids, ['e1', 'e2', 'e3']);
  });

  it('el hilo no crece sin límite', () => {
    let state = run([WELCOME]);
    for (let i = 0; i < MAX_ENTRIES + 40; i++) {
      state = reduce(state, { t: 'msg', from: '@ana', text: `m${i}` }, i);
    }
    assert.equal(state.entries.length, MAX_ENTRIES);
    assert.equal(state.entries.at(-1)?.text, `m${MAX_ENTRIES + 39}`);
  });

  it('los mencionables incluyen tags y los destinos especiales', () => {
    const state = run([
      WELCOME,
      { t: 'room_state', members: [member('@ana'), member('@ana', { tag: 'api' })] },
    ]);
    assert.deepEqual(mentionables(state), ['@ana', '@ana:api', '@all', '@auto']);
  });
});
