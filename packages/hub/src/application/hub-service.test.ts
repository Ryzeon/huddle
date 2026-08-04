import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { PROTOCOL_VERSION, type ServerMessage } from '@huddle/protocol';
import type { TranscriptEntry } from '../domain/room.js';
import { HubService, DEFAULT_HUB_CONFIG } from './hub-service.js';
import type { MemberChannelPort, TimerPort } from './ports/member-channel.js';

/**
 * Antes del refactor esto no se podía escribir: la lógica de sala vivía
 * pegada a `ws`, así que probar un timeout o una desconexión a mitad de
 * respuesta exigía levantar un servidor de verdad.
 */

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

  /** Último mensaje de un tipo dado, que es lo que casi siempre se afirma. */
  last<T extends ServerMessage['t']>(type: T): Extract<ServerMessage, { t: T }> | undefined {
    for (let i = this.sent.length - 1; i >= 0; i--) {
      if (this.sent[i]!.t === type) return this.sent[i] as Extract<ServerMessage, { t: T }>;
    }
    return undefined;
  }
}

/** Temporizadores manuales: los tests deciden cuándo pasa el tiempo. */
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

describe('HubService', () => {
  let clockNow: number;
  let timers: ManualTimers;
  let hub: HubService;
  let transcripts: { code: string; name: string; entry: TranscriptEntry }[];
  let codeSeq = 0;
  let roomCode: string;

  /** El primero crea la sala; los demás entran con el código que devolvió. */
  const join = (channel: FakeChannel, alias: string, repo = 'repo') => {
    if (!roomCode) {
      hub.handle(channel, {
        t: 'create',
        v: PROTOCOL_VERSION,
        name: 'Equipo',
        alias,
        card: { repo, dirs: [] },
        quotaRemaining: 10,
      });
      roomCode = channel.last('welcome')?.room ?? '';
      return;
    }
    hub.handle(channel, {
      t: 'join',
      v: PROTOCOL_VERSION,
      room: roomCode,
      alias,
      card: { repo, dirs: [] },
      quotaRemaining: 10,
    });
  };

  beforeEach(() => {
    clockNow = 1_000_000;
    roomCode = '';
    timers = new ManualTimers();
    transcripts = [];
    hub = new HubService({
      clock: { now: () => clockNow },
      timers,
      transcripts: {
        append: (code, name, entry) => transcripts.push({ code, name, entry }),
        read: () => [],
        purge: () => 0,
      },
      generateCode: () => `TEST${++codeSeq}-ROOM1`,
    });
  });

  test('quien entra recibe welcome y aparece en el roster de los demás', () => {
    const a = new FakeChannel('a');
    const b = new FakeChannel('b');
    join(a, '@ana');
    join(b, '@beto');

    const welcome = b.last('welcome');
    assert.equal(welcome?.you, '@beto');
    assert.equal(a.last('room_state')?.members.length, 2);
  });

  test('una pregunta dirigida llega solo a su destinatario', () => {
    const a = new FakeChannel('a');
    const b = new FakeChannel('b');
    const c = new FakeChannel('c');
    join(a, '@ana');
    join(b, '@beto');
    join(c, '@caro');

    hub.handle(a, { t: 'ask', id: 'q1', to: '@beto', q: '¿dónde está el login?', ttl: 60 });

    assert.equal(b.last('request')?.q, '¿dónde está el login?');
    assert.equal(c.last('request'), undefined, '@caro no debería recibirla');
  });

  test('@all no le pregunta al que preguntó', () => {
    const a = new FakeChannel('a');
    const b = new FakeChannel('b');
    join(a, '@ana');
    join(b, '@beto');

    hub.handle(a, { t: 'ask', id: 'q1', to: '@all', q: 'hola', ttl: 60 });

    assert.ok(b.last('request'));
    assert.equal(a.last('request'), undefined, 'preguntarse a uno mismo gasta cuota para nada');
  });

  test('@auto elige por la tarjeta de capacidades', () => {
    const a = new FakeChannel('a');
    const infra = new FakeChannel('b');
    const pagos = new FakeChannel('c');
    join(a, '@ana');
    join(infra, '@beto', 'terraform-infra');
    join(pagos, '@caro', 'servicio-pagos');

    hub.handle(a, { t: 'ask', id: 'q1', to: '@auto', q: 'cómo se cobran los pagos', ttl: 60 });

    assert.ok(pagos.last('request'), '@caro tiene el repo de pagos');
    assert.equal(infra.last('request'), undefined);
  });

  test('la respuesta vuelve etiquetada con quién respondió', () => {
    const a = new FakeChannel('a');
    const b = new FakeChannel('b');
    join(a, '@ana');
    join(b, '@beto');
    hub.handle(a, { t: 'ask', id: 'q1', to: '@beto', q: 'x', ttl: 60 });

    hub.handle(b, {
      t: 'result',
      id: 'q1',
      answer: 'en src/a.ts',
      sources: [{ file: 'src/a.ts' }],
      confidence: 'high',
      elapsedMs: 1200,
      cached: false,
    });

    const result = a.last('result');
    assert.equal(result?.answer, 'en src/a.ts');
    assert.equal(result?.from, '@beto', 'sin `from`, un @all es indescifrable');
  });

  test('la respuesta queda en el transcript de la sala', () => {
    const a = new FakeChannel('a');
    const b = new FakeChannel('b');
    join(a, '@ana');
    join(b, '@beto');
    hub.handle(a, { t: 'ask', id: 'q1', to: '@beto', q: '¿y el login?', ttl: 60 });
    hub.handle(b, {
      t: 'result',
      id: 'q1',
      answer: 'ahí',
      sources: [],
      confidence: 'medium',
      elapsedMs: 10,
      cached: false,
    });

    const [entry] = hub.transcriptOf(roomCode);
    assert.equal(entry?.question, '¿y el login?');
    assert.equal(entry?.from, '@ana');
    assert.equal(entry?.to, '@beto');
  });

  test('si nadie responde en el TTL, avisa en vez de dejar colgado', () => {
    const a = new FakeChannel('a');
    const b = new FakeChannel('b');
    join(a, '@ana');
    join(b, '@beto');
    hub.handle(a, { t: 'ask', id: 'q1', to: '@beto', q: 'x', ttl: 30 });

    timers.advance(30_000);

    const error = a.last('error');
    assert.equal(error?.reason, 'timeout');
  });

  test('una respuesta a tiempo cancela el timeout', () => {
    const a = new FakeChannel('a');
    const b = new FakeChannel('b');
    join(a, '@ana');
    join(b, '@beto');
    hub.handle(a, { t: 'ask', id: 'q1', to: '@beto', q: 'x', ttl: 30 });
    assert.equal(timers.pending, 1);

    hub.handle(b, {
      t: 'result',
      id: 'q1',
      answer: 'ok',
      sources: [],
      confidence: 'high',
      elapsedMs: 5,
      cached: false,
    });

    assert.equal(timers.pending, 0, 'el timeout debería quedar cancelado');
  });

  test('si el que responde se cae, avisa al que preguntaba de inmediato', () => {
    const a = new FakeChannel('a');
    const b = new FakeChannel('b');
    join(a, '@ana');
    join(b, '@beto');
    hub.handle(a, { t: 'ask', id: 'q1', to: '@beto', q: 'x', ttl: 300 });

    hub.disconnect(b.id);

    const error = a.last('error');
    assert.equal(error?.reason, 'target_offline');
    assert.equal(error?.from, '@beto');
  });

  test('corta la ráfaga de preguntas con la cubeta de tokens', () => {
    const a = new FakeChannel('a');
    const b = new FakeChannel('b');
    join(a, '@ana');
    join(b, '@beto');

    const burst = DEFAULT_HUB_CONFIG.askPolicy.burst;
    for (let i = 0; i < burst; i++) {
      hub.handle(a, { t: 'ask', id: `q${i}`, to: '@beto', q: 'x', ttl: 60 });
    }
    assert.equal(a.last('error'), undefined, 'la ráfaga permitida debería pasar entera');

    hub.handle(a, { t: 'ask', id: 'q-extra', to: '@beto', q: 'x', ttl: 60 });
    assert.equal(a.last('error')?.reason, 'rate_limited');
  });

  test('la cubeta se repone con el tiempo', () => {
    const a = new FakeChannel('a');
    const b = new FakeChannel('b');
    join(a, '@ana');
    join(b, '@beto');

    for (let i = 0; i < DEFAULT_HUB_CONFIG.askPolicy.burst + 1; i++) {
      hub.handle(a, { t: 'ask', id: `q${i}`, to: '@beto', q: 'x', ttl: 60 });
    }
    assert.equal(a.last('error')?.reason, 'rate_limited');

    clockNow += DEFAULT_HUB_CONFIG.askPolicy.refillMs;
    hub.handle(a, { t: 'ask', id: 'q-despues', to: '@beto', q: 'x', ttl: 60 });
    assert.equal(b.last('request')?.id, 'q-despues');
  });

  test('preguntar a alguien que no está devuelve target_offline', () => {
    const a = new FakeChannel('a');
    join(a, '@ana');

    hub.handle(a, { t: 'ask', id: 'q1', to: '@fantasma', q: 'x', ttl: 60 });
    assert.equal(a.last('error')?.reason, 'target_offline');
  });

  test('sin join previo, cualquier mensaje se rechaza', () => {
    const a = new FakeChannel('a');
    hub.handle(a, { t: 'ask', id: 'q1', to: '@beto', q: 'x', ttl: 60 });
    assert.match(a.last('error')?.detail ?? '', /join/);
  });

  test('rechaza una versión de protocolo distinta', () => {
    const a = new FakeChannel('a');
    hub.handle(a, {
      t: 'join',
      v: PROTOCOL_VERSION + 1,
      room: 'sala',
      alias: '@ana',
      quotaRemaining: null,
    });
    assert.equal(a.closed?.code, 4002);
  });

  test('al reconectar con el mismo alias, cierra el canal viejo', () => {
    const viejo = new FakeChannel('viejo');
    const nuevo = new FakeChannel('nuevo');
    join(viejo, '@ana');
    join(nuevo, '@ana');

    assert.equal(viejo.closed?.code, 4003);
    assert.equal(hub.stats().members, 1, 'no debería quedar un fantasma en el roster');
  });

  test('el barrido expulsa a quien dejó de latir', () => {
    const a = new FakeChannel('a');
    join(a, '@ana');
    assert.equal(hub.stats().members, 1);

    clockNow += DEFAULT_HUB_CONFIG.heartbeatTimeoutMs + 1;
    hub.sweep();

    assert.equal(hub.stats().members, 0);
    assert.equal(a.closed?.code, 4004);
  });

  test('el latido mantiene vivo al miembro y actualiza su cuota', () => {
    const a = new FakeChannel('a');
    join(a, '@ana');

    clockNow += DEFAULT_HUB_CONFIG.heartbeatTimeoutMs - 1;
    hub.handle(a, { t: 'ping', quotaRemaining: 3 });
    clockNow += 2;
    hub.sweep();

    assert.equal(hub.stats().members, 1);
    const roster = a.last('room_state')?.members ?? [];
    assert.equal(roster[0]?.quotaRemaining, 3);
  });
});
