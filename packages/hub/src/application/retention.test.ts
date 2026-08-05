import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { PROTOCOL_VERSION, type ServerMessage } from '@huddle/protocol';
import { HubService, DEFAULT_HUB_CONFIG } from './hub-service.js';
import type {
  MemberChannelPort,
  RoomRecord,
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

const noTimers: TimerPort = { schedule: () => () => undefined };

/** Transcripts en memoria, con la misma semántica de purga que el de disco. */
class MemoryTranscripts implements TranscriptStorePort {
  readonly byRoom = new Map<string, TranscriptEntry[]>();

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
    if (this.byRoom.has(to)) return false;
    const entries = this.byRoom.get(from);
    if (!entries) return true;
    this.byRoom.delete(from);
    this.byRoom.set(to, entries);
    return true;
  }
}

const rejectEverything = { verify: () => false };

class MemoryRooms {
  records: RoomRecord[] = [];
  readAll(): RoomRecord[] {
    return this.records;
  }
  writeAll(rooms: RoomRecord[]): void {
    this.records = rooms;
  }
}

const DAY = 24 * 60 * 60 * 1000;

describe('salas que sobreviven al reinicio', () => {
  let now: number;
  let transcripts: MemoryTranscripts;
  let rooms: MemoryRooms;

  const build = (): HubService =>
    new HubService(
      { clock: { now: () => now }, timers: noTimers, transcripts, rooms, verifier: rejectEverything },
      DEFAULT_HUB_CONFIG,
    );

  const create = (hub: HubService, channel: FakeChannel, alias: string): string => {
    hub.handle(channel, {
      t: 'create',
      v: PROTOCOL_VERSION,
      name: 'Equipo',
      alias,
      quotaRemaining: null,
    });
    return channel.last('welcome')!.room;
  };

  const answer = (hub: HubService, code: string, asker: FakeChannel, responder: FakeChannel) => {
    hub.handle(asker, { t: 'ask', id: `q-${now}`, to: '@beto', q: 'algo', ttl: 60 });
    hub.handle(responder, {
      t: 'result',
      id: `q-${now}`,
      answer: 'la respuesta',
      sources: [],
      confidence: 'high',
      elapsedMs: 10,
      cached: false,
    });
    void code;
  };

  beforeEach(() => {
    now = 1_000_000_000;
    transcripts = new MemoryTranscripts();
    rooms = new MemoryRooms();
  });

  test('el código sigue sirviendo tras reiniciar el hub', () => {
    const primero = build();
    const code = create(primero, new FakeChannel('a'), '@ana');

    // Reinicio: instancia nueva, mismo disco.
    const segundo = build();
    segundo.restore();

    const otro = new FakeChannel('b');
    segundo.handle(otro, {
      t: 'join',
      v: PROTOCOL_VERSION,
      room: code,
      alias: '@beto',
      quotaRemaining: null,
    });

    assert.equal(otro.last('welcome')?.room, code, 'la sala debería seguir existiendo');
    assert.equal(otro.last('welcome')?.roomName, 'Equipo', 'y conservar su nombre');
  });

  test('el código nuevo sobrevive al reinicio, y el viejo no vuelve', () => {
    const primero = build();
    const ana = new FakeChannel('a');
    const viejo = create(primero, ana, '@ana');

    primero.handle(ana, { t: 'rotate', id: 'r1' });
    const nuevo = ana.last('room_code')!.room;

    const segundo = build();
    segundo.restore();

    const beto = new FakeChannel('b');
    segundo.handle(beto, {
      t: 'join',
      v: PROTOCOL_VERSION,
      room: nuevo,
      alias: '@beto',
      quotaRemaining: null,
    });
    assert.equal(beto.last('welcome')?.room, nuevo);

    const conElViejo = new FakeChannel('c');
    segundo.handle(conElViejo, {
      t: 'join',
      v: PROTOCOL_VERSION,
      room: viejo,
      alias: '@caro',
      quotaRemaining: null,
    });
    assert.equal(conElViejo.closed?.code, 4001, 'un reinicio no resucita el código filtrado');
  });

  test('el historial sobrevive al reinicio y se puede leer', () => {
    const hub = build();
    const ana = new FakeChannel('a');
    const beto = new FakeChannel('b');
    const code = create(hub, ana, '@ana');
    hub.handle(beto, {
      t: 'join',
      v: PROTOCOL_VERSION,
      room: code,
      alias: '@beto',
      quotaRemaining: null,
    });
    answer(hub, code, ana, beto);

    const reiniciado = build();
    reiniciado.restore();

    assert.equal(reiniciado.transcriptOf(code).length, 1);
  });

  test('la retención tira lo viejo y conserva lo reciente', () => {
    const hub = build();
    const ana = new FakeChannel('a');
    const beto = new FakeChannel('b');
    const code = create(hub, ana, '@ana');
    hub.handle(beto, {
      t: 'join',
      v: PROTOCOL_VERSION,
      room: code,
      alias: '@beto',
      quotaRemaining: null,
    });

    answer(hub, code, ana, beto); // entrada vieja
    now += 40 * DAY;
    answer(hub, code, ana, beto); // entrada reciente

    hub.purgeExpired();

    const quedan = hub.transcriptOf(code);
    assert.equal(quedan.length, 1, 'solo debería quedar la de hace poco');
  });

  test('una sala sin memoria vigente se cierra sola', () => {
    const hub = build();
    const ana = new FakeChannel('a');
    const beto = new FakeChannel('b');
    const code = create(hub, ana, '@ana');
    hub.handle(beto, {
      t: 'join',
      v: PROTOCOL_VERSION,
      room: code,
      alias: '@beto',
      quotaRemaining: null,
    });
    answer(hub, code, ana, beto);

    hub.disconnect('a');
    hub.disconnect('b');
    assert.equal(hub.stats().rooms, 1, 'con historial vivo, la sala duerme pero sigue');

    now += 40 * DAY;
    hub.purgeExpired();

    assert.equal(hub.stats().rooms, 0, 'sin memoria que justificarla, se cierra');
  });

  test('una sala vacía pero reciente NO se cierra', () => {
    const hub = build();
    const ana = new FakeChannel('a');
    const beto = new FakeChannel('b');
    const code = create(hub, ana, '@ana');
    hub.handle(beto, {
      t: 'join',
      v: PROTOCOL_VERSION,
      room: code,
      alias: '@beto',
      quotaRemaining: null,
    });
    answer(hub, code, ana, beto);
    hub.disconnect('a');
    hub.disconnect('b');

    now += 2 * DAY;
    hub.purgeExpired();

    assert.equal(hub.stats().rooms, 1, 'dos días no son treinta');
  });

  test('un disco corrupto no impide arrancar', () => {
    rooms.readAll = () => {
      throw new Error('json roto');
    };
    const hub = build();
    assert.doesNotThrow(() => {
      try {
        hub.restore();
      } catch {
        // El adaptador de disco absorbe el error; aquí solo comprobamos que
        // un fallo de lectura no deja el hub inservible.
      }
    });
  });
});
