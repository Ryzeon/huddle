import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { PROTOCOL_VERSION, type ServerMessage } from '@huddle/protocol';
import { HubService, DEFAULT_HUB_CONFIG } from './hub-service.js';
import type {
  MemberChannelPort,
  TimerPort,
  TranscriptStorePort,
} from './ports/member-channel.js';
import type { TranscriptEntry } from '../domain/room.js';

class FakeChannel implements MemberChannelPort {
  readonly sent: ServerMessage[] = [];
  closed?: { code: number; reason: string };
  constructor(readonly id: string) {}
  send(message: ServerMessage): void {
    this.sent.push(message);
  }
  close(code: number, reason: string): void {
    this.closed = { code, reason };
  }
  last<T extends ServerMessage['t']>(type: T): Extract<ServerMessage, { t: T }> | undefined {
    for (let i = this.sent.length - 1; i >= 0; i--) {
      if (this.sent[i]!.t === type) return this.sent[i] as Extract<ServerMessage, { t: T }>;
    }
    return undefined;
  }
}

class ManualTimers implements TimerPort {
  private readonly tasks: { at: number; task: () => void; cancelled: boolean }[] = [];
  now = 0;
  schedule(delayMs: number, task: () => void): () => void {
    const entry = { at: this.now + delayMs, task, cancelled: false };
    this.tasks.push(entry);
    return () => {
      entry.cancelled = true;
    };
  }
  advance(ms: number): void {
    this.now += ms;
    for (const entry of this.tasks) {
      if (!entry.cancelled && entry.at <= this.now) {
        entry.cancelled = true;
        entry.task();
      }
    }
  }
  get pending(): number {
    return this.tasks.filter((t) => !t.cancelled).length;
  }
}

class MemoryTranscripts implements TranscriptStorePort {
  readonly byRoom = new Map<string, TranscriptEntry[]>();
  renameFails = false;

  append(roomCode: string, _name: string, entry: TranscriptEntry): void {
    const list = this.byRoom.get(roomCode) ?? [];
    list.push(entry);
    this.byRoom.set(roomCode, list);
  }
  read(roomCode: string): TranscriptEntry[] {
    return this.byRoom.get(roomCode) ?? [];
  }
  purge(roomCode: string, cutoff: number): number {
    const kept = this.read(roomCode).filter((e) => e.at >= cutoff);
    if (kept.length === 0) this.byRoom.delete(roomCode);
    else this.byRoom.set(roomCode, kept);
    return kept.length;
  }
  rename(from: string, to: string): boolean {
    if (this.renameFails || this.byRoom.has(to)) return false;
    const entries = this.byRoom.get(from);
    if (!entries) return true;
    this.byRoom.delete(from);
    this.byRoom.set(to, entries);
    return true;
  }
}

const rejectEverything = { verify: () => false };

describe('rotar el código de la sala', () => {
  let now: number;
  let hub: HubService;
  let timers: ManualTimers;
  let transcripts: MemoryTranscripts;
  let code: string;
  let ana: FakeChannel;
  let seq: number;

  // Un generador constante agotaría `freeCode`: la sala vieja todavía ocupa su
  // código cuando se pide el nuevo.
  const codes = () => `SALA${++seq}-CODIG`;

  const create = (channel: FakeChannel, alias: string): string => {
    hub.handle(channel, {
      t: 'create',
      v: PROTOCOL_VERSION,
      name: 'Equipo',
      alias,
      card: { repo: 'repo', dirs: [] },
      quotaRemaining: 10,
    });
    return channel.last('welcome')!.room;
  };

  const join = (channel: FakeChannel, alias: string, room = code) => {
    hub.handle(channel, {
      t: 'join',
      v: PROTOCOL_VERSION,
      room,
      alias,
      card: { repo: 'repo', dirs: [] },
      quotaRemaining: 10,
    });
  };

  beforeEach(() => {
    now = 1_000_000;
    seq = 0;
    timers = new ManualTimers();
    transcripts = new MemoryTranscripts();
    hub = new HubService(
      {
        clock: { now: () => now },
        timers,
        transcripts,
        verifier: rejectEverything,
        generateCode: codes,
      },
      DEFAULT_HUB_CONFIG,
    );
    ana = new FakeChannel('ana');
    code = create(ana, '@ana');
  });

  test('el anfitrión recibe el código nuevo y el viejo deja de servir', () => {
    hub.handle(ana, { t: 'rotate', id: 'r1' });

    const nuevo = ana.last('room_code');
    assert.equal(nuevo?.previous, code);
    assert.notEqual(nuevo?.room, code);

    const tarde = new FakeChannel('tarde');
    join(tarde, '@tarde', code);
    assert.match(tarde.last('error')?.detail ?? '', /no existe/);
    assert.equal(tarde.closed?.code, 4001);
  });

  test('con el código nuevo se entra', () => {
    hub.handle(ana, { t: 'rotate', id: 'r1' });
    const nuevo = ana.last('room_code')!.room;

    const beto = new FakeChannel('beto');
    join(beto, '@beto', nuevo);
    assert.equal(beto.last('welcome')?.room, nuevo);
  });

  test('la respuesta lleva el id de la rotación', () => {
    hub.handle(ana, { t: 'rotate', id: 'r-concreto' });
    assert.equal(ana.last('room_code')?.id, 'r-concreto');
  });

  test('a los demás se les echa con 4006 y el motivo', () => {
    const beto = new FakeChannel('beto');
    join(beto, '@beto');

    hub.handle(ana, { t: 'rotate', id: 'r1' });

    assert.equal(beto.last('room_closed')?.reason, 'code_rotated');
    assert.equal(beto.closed?.code, 4006);
    assert.equal(beto.last('room_code'), undefined, 'el código nuevo no es para él');
  });

  test('a quien se echa se le da de baja del roster, no solo se le corta', () => {
    const beto = new FakeChannel('beto');
    join(beto, '@beto');

    hub.handle(ana, { t: 'rotate', id: 'r1' });

    assert.equal(hub.stats().members, 1, 'sin `leaveRoom` quedaría un fantasma');
  });

  test('quien no es anfitrión no puede rotar', () => {
    const beto = new FakeChannel('beto');
    join(beto, '@beto');

    hub.handle(beto, { t: 'rotate', id: 'r1' });

    const error = beto.last('error');
    assert.equal(error?.reason, 'denied_by_owner');
    assert.equal(error?.id, 'r1', 'sin el id, el cliente no sabe qué rotación falló');
    assert.equal(ana.last('room_code'), undefined, 'el código no ha cambiado');
  });

  test('la sala sigue siendo la misma: nombre, dueño e historial', () => {
    const beto = new FakeChannel('beto');
    join(beto, '@beto');
    hub.handle(ana, { t: 'ask', id: 'q1', to: '@beto', q: '¿y el login?', ttl: 60 });
    hub.handle(beto, {
      t: 'result',
      id: 'q1',
      answer: 'en src/auth.ts',
      sources: [],
      confidence: 'high',
      elapsedMs: 10,
      cached: false,
    });

    hub.handle(ana, { t: 'rotate', id: 'r1' });
    const nuevo = ana.last('room_code')!.room;

    assert.equal(hub.transcriptOf(nuevo).length, 1, 'el historial viaja con la sala');
    assert.equal(hub.transcriptOf(code).length, 0, 'y deja de servirse por el código viejo');

    const vuelve = new FakeChannel('ana-2');
    join(vuelve, '@ana', nuevo);
    assert.equal(vuelve.last('welcome')?.roomName, 'Equipo');
    assert.equal(vuelve.last('welcome')?.host, '@ana', 'la sala sigue siendo suya');
  });

  test('el anfitrión puede seguir hablando sin volver a entrar', () => {
    hub.handle(ana, { t: 'rotate', id: 'r1' });

    hub.handle(ana, { t: 'msg', text: 'hola' });

    assert.notEqual(
      ana.last('error')?.detail,
      'hay que mandar `join` primero',
      'si `roomOfChannel` no se reasigna, el anfitrión se queda fuera de su sala',
    );
  });

  test('una pregunta en vuelo se cancela en vez de esperar al timeout', () => {
    const beto = new FakeChannel('beto');
    join(beto, '@beto');
    hub.handle(ana, { t: 'ask', id: 'q1', to: '@beto', q: 'x', ttl: 120 });
    assert.equal(timers.pending, 1);

    hub.handle(ana, { t: 'rotate', id: 'r1' });

    const error = ana.last('error');
    assert.equal(error?.id, 'q1');
    assert.equal(error?.reason, 'target_offline');
    assert.equal(timers.pending, 0, 'el temporizador debería quedar cancelado');
  });

  test('si el historial no se puede mover, no se cambia nada', () => {
    transcripts.renameFails = true;
    const beto = new FakeChannel('beto');
    join(beto, '@beto');

    hub.handle(ana, { t: 'rotate', id: 'r1' });

    assert.equal(ana.last('error')?.reason, 'bad_request');
    assert.equal(ana.last('room_code'), undefined);
    assert.equal(beto.closed, undefined, 'nadie debería haber salido');

    const otro = new FakeChannel('otro');
    join(otro, '@otro', code);
    assert.equal(otro.last('welcome')?.room, code, 'el código de siempre sigue sirviendo');
  });

  test('rotar dos veces seguidas encadena los códigos', () => {
    hub.handle(ana, { t: 'rotate', id: 'r1' });
    const primero = ana.last('room_code')!.room;

    hub.handle(ana, { t: 'rotate', id: 'r2' });
    const segundo = ana.last('room_code')!;

    assert.equal(segundo.previous, primero);
    assert.notEqual(segundo.room, primero);
    assert.equal(hub.stats().rooms, 1, 'sigue habiendo una sola sala');
  });

  test('todas las conexiones del anfitrión reciben el código nuevo', () => {
    const api = new FakeChannel('ana-api');
    hub.handle(api, {
      t: 'join',
      v: PROTOCOL_VERSION,
      room: code,
      alias: '@ana',
      tag: 'api',
      quotaRemaining: null,
    });

    hub.handle(ana, { t: 'rotate', id: 'r1' });

    assert.ok(api.last('room_code'), 'su otro repo también tiene que enterarse');
    assert.equal(api.last('room_code')?.room, ana.last('room_code')?.room);
  });
});
