import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { PROTOCOL_VERSION, identityProofText, type ServerMessage } from '@huddle/protocol';
import { HubService, DEFAULT_HUB_CONFIG } from './hub-service.js';
import { ed25519Verifier } from '../adapters/outbound/ed25519.js';
import type {
  MemberChannelPort,
  RoomRecord,
  TimerPort,
  TranscriptStorePort,
} from './ports/member-channel.js';

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
const noTranscripts: TranscriptStorePort = {
  append: () => undefined,
  read: () => [],
  purge: () => 0,
  rename: () => true,
};

class MemoryRooms {
  records: RoomRecord[] = [];
  readAll(): RoomRecord[] {
    return this.records;
  }
  writeAll(rooms: RoomRecord[]): void {
    this.records = rooms;
  }
}

function identity(): { pubkey: string; sign: (text: string) => string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string };
  return {
    pubkey: jwk.x,
    sign: (text) => sign(null, Buffer.from(text, 'utf8'), privateKey).toString('base64url'),
  };
}

describe('la puerta sobrevive al reinicio', () => {
  let now: number;
  let rooms: MemoryRooms;
  let hub: HubService;
  let seq: number;
  let ana: ReturnType<typeof identity>;
  let beto: ReturnType<typeof identity>;

  const build = (): HubService =>
    new HubService(
      {
        clock: { now: () => now },
        timers: noTimers,
        transcripts: noTranscripts,
        rooms,
        verifier: ed25519Verifier,
        generateCode: () => `SALA${++seq}-CODIG`,
      },
      DEFAULT_HUB_CONFIG,
    );

  const greet = (channel: FakeChannel): string => {
    hub.greet(channel);
    return channel.last('challenge')!.nonce;
  };

  const create = (channel: FakeChannel, alias: string, who: ReturnType<typeof identity>) => {
    const nonce = greet(channel);
    hub.handle(channel, {
      t: 'create',
      v: PROTOCOL_VERSION,
      name: 'Equipo',
      alias,
      quotaRemaining: null,
      policy: 'approved',
      proof: {
        pubkey: who.pubkey,
        sig: who.sign(identityProofText({ kind: 'create', room: '', alias, nonce })),
        nonce,
      },
    });
    return channel.last('welcome')!.room;
  };

  const join = (
    channel: FakeChannel,
    alias: string,
    room: string,
    who: ReturnType<typeof identity>,
  ) => {
    const nonce = greet(channel);
    hub.handle(channel, {
      t: 'join',
      v: PROTOCOL_VERSION,
      room,
      alias,
      quotaRemaining: null,
      proof: {
        pubkey: who.pubkey,
        sig: who.sign(identityProofText({ kind: 'join', room, alias, nonce })),
        nonce,
      },
    });
  };

  const restart = (): void => {
    hub = build();
    hub.restore();
  };

  beforeEach(() => {
    now = 1_000_000;
    seq = 0;
    rooms = new MemoryRooms();
    ana = identity();
    beto = identity();
    hub = build();
  });

  test('la lista de aprobados sobrevive al reinicio', () => {
    const anfitrion = new FakeChannel('ana');
    const code = create(anfitrion, '@ana', ana);
    const canal = new FakeChannel('beto');
    join(canal, '@beto', code, beto);
    hub.handle(anfitrion, { t: 'admit', id: anfitrion.last('join_request')!.id });

    restart();

    const vuelve = new FakeChannel('beto-2');
    join(vuelve, '@beto', code, beto);
    assert.ok(vuelve.last('welcome'), 'ya estaba aprobado antes del reinicio');
  });

  test('la política sobrevive: la sala no se abre sola al reiniciar', () => {
    const anfitrion = new FakeChannel('ana');
    const code = create(anfitrion, '@ana', ana);

    restart();

    const desconocido = new FakeChannel('caro');
    join(desconocido, '@caro', code, identity());
    assert.ok(desconocido.last('waiting_approval'), 'seguiría siendo una sala cerrada');
    assert.equal(desconocido.last('welcome'), undefined);
  });

  test('el dueño entra sin aprobación tras un reinicio con la sala vacía', () => {
    const anfitrion = new FakeChannel('ana');
    const code = create(anfitrion, '@ana', ana);
    hub.disconnect('ana');

    restart();

    const vuelve = new FakeChannel('ana-2');
    join(vuelve, '@ana', code, ana);
    assert.ok(
      vuelve.last('welcome'),
      'sin ownerKey en disco, la dueña esperaría a que le abriera nadie',
    );
  });

  test('un registro sin política se lee como sala abierta', () => {
    rooms.records = [{ code: 'VIEJA-SALA1', name: 'De antes', createdAt: 1 }];
    restart();

    const canal = new FakeChannel('beto');
    join(canal, '@beto', 'VIEJA-SALA1', beto);

    assert.ok(canal.last('welcome'), 'las salas de antes de esto no cambian de comportamiento');
  });

  test('una lista de aprobados corrupta no abre la sala', () => {
    const anfitrion = new FakeChannel('ana');
    const code = create(anfitrion, '@ana', ana);

    const record = rooms.records.find((r) => r.code === code)!;
    record.approved = 'esto no es una lista' as never;

    restart();

    const desconocido = new FakeChannel('caro');
    join(desconocido, '@caro', code, identity());

    assert.ok(
      desconocido.last('waiting_approval'),
      'perder la lista deja a todos fuera; perder la política los dejaría a todos dentro',
    );
  });

  test('una política desconocida se lee como abierta, no como aprobada', () => {
    rooms.records = [
      { code: 'RARA-SALA11', name: 'Rara', createdAt: 1, policy: 'lo-que-sea' as never },
    ];
    restart();

    const canal = new FakeChannel('beto');
    join(canal, '@beto', 'RARA-SALA11', beto);

    assert.ok(canal.last('welcome'));
  });

  test('expulsar se guarda: el reinicio no le devuelve la aprobación', () => {
    const anfitrion = new FakeChannel('ana');
    const code = create(anfitrion, '@ana', ana);
    const canal = new FakeChannel('beto');
    join(canal, '@beto', code, beto);
    hub.handle(anfitrion, { t: 'admit', id: anfitrion.last('join_request')!.id });
    hub.handle(anfitrion, { t: 'kick', alias: '@beto' });

    restart();

    const vuelve = new FakeChannel('beto-2');
    join(vuelve, '@beto', code, beto);
    assert.ok(vuelve.last('waiting_approval'), 'la expulsión no se deshace sola');
  });
});
