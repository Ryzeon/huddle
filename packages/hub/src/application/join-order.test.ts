import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { PROTOCOL_VERSION, identityProofText, type ServerMessage } from '@huddle/protocol';
import { HubService, DEFAULT_HUB_CONFIG } from './hub-service.js';
import { MAX_KEYS } from '../domain/room.js';
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
  all<T extends ServerMessage['t']>(type: T): Extract<ServerMessage, { t: T }>[] {
    return this.sent.filter((m) => m.t === type) as Extract<ServerMessage, { t: T }>[];
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

describe('la puerta antes que la identidad', () => {
  let now: number;
  let hub: HubService;
  let rooms: MemoryRooms;
  let seq: number;
  let ana: ReturnType<typeof identity>;

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

  const create = (
    channel: FakeChannel,
    alias: string,
    who?: ReturnType<typeof identity>,
    policy?: 'approved',
  ): string => {
    const nonce = greet(channel);
    hub.handle(channel, {
      t: 'create',
      v: PROTOCOL_VERSION,
      name: 'Equipo',
      alias,
      quotaRemaining: null,
      ...(policy && { policy }),
      ...(who && {
        proof: {
          pubkey: who.pubkey,
          sig: who.sign(identityProofText({ kind: 'create', room: '', alias, nonce })),
          nonce,
        },
      }),
    });
    return channel.last('welcome')!.room;
  };

  const join = (
    channel: FakeChannel,
    alias: string,
    room: string,
    who?: ReturnType<typeof identity>,
  ): void => {
    const nonce = greet(channel);
    hub.handle(channel, {
      t: 'join',
      v: PROTOCOL_VERSION,
      room,
      alias,
      quotaRemaining: null,
      ...(who && {
        proof: {
          pubkey: who.pubkey,
          sig: who.sign(identityProofText({ kind: 'join', room, alias, nonce })),
          nonce,
        },
      }),
    });
  };

  /** Deja entrar al que espera, por el id de su solicitud. */
  const admitir = (anfitrion: FakeChannel, id: string): void => {
    hub.handle(anfitrion, { t: 'admit', id });
  };

  beforeEach(() => {
    now = 1_000_000;
    seq = 0;
    rooms = new MemoryRooms();
    hub = build();
    ana = identity();
  });

  test('con la tabla de claves llena nadie sale verificado sin vínculo', () => {
    const anfitrion = new FakeChannel('host');
    const code = create(anfitrion, '@host');

    for (let i = 0; i < MAX_KEYS; i++) {
      join(new FakeChannel(`relleno-${i}`), `@relleno${i}`, code, identity());
    }

    const primera = new FakeChannel('zoe-1');
    join(primera, '@zoe', code, identity());
    const segunda = new FakeChannel('zoe-2');
    join(segunda, '@zoe', code, identity());

    assert.equal(primera.last('welcome')?.verified, false, 'sin vínculo no hay insignia');
    assert.equal(segunda.last('welcome')?.verified, false, 'la segunda clave tampoco');

    const zoe = anfitrion.last('room_state')?.members.find((m) => m.alias === '@zoe');
    assert.equal(zoe?.verified, undefined, 'la insignia mentiría: el vínculo no se escribió');
    assert.equal(zoe?.key, undefined, 'ni media insignia');
  });

  test('a quien rechazan en la puerta no se le queda el alias', () => {
    const anfitriona = new FakeChannel('ana');
    const code = create(anfitriona, '@ana', ana, 'approved');

    const extrano = new FakeChannel('extrano');
    join(extrano, '@carla', code, identity());
    hub.handle(anfitriona, { t: 'deny', id: anfitriona.last('join_request')!.id });

    const carla = new FakeChannel('carla');
    join(carla, '@carla', code, identity());

    assert.notEqual(carla.closed?.code, 4007, 'nadie le quemó el nombre desde la puerta');
    assert.ok(carla.last('waiting_approval'), 'pide entrar como siempre');
    assert.equal(
      Object.keys(rooms.records[0]?.keys ?? {}).includes('@carla'),
      false,
      'esperar en la puerta no se escribe en disco',
    );
  });

  test('quien espera en la puerta no echa a nadie de la sala', () => {
    const anfitriona = new FakeChannel('ana');
    const code = create(anfitriona, '@ana', ana, 'approved');

    const bob = new FakeChannel('bob');
    join(bob, '@bob', code);
    admitir(anfitriona, anfitriona.last('join_request')!.id);
    assert.ok(bob.last('welcome'), '@bob entró sin firmar, porque le abrieron');

    const extrano = new FakeChannel('extrano');
    join(extrano, '@bob', code, identity());

    assert.equal(bob.last('room_closed'), undefined, 'el desconocido sigue en la puerta');
    assert.equal(bob.closed, undefined);
    assert.ok(extrano.last('waiting_approval'));
    assert.equal(
      anfitriona.last('room_state')?.members.some((m) => m.alias === '@bob'),
      true,
      'el roster del anfitrión y la sala dicen lo mismo',
    );
  });

  test('admitir a quien reemplaza a un miembro le cierra el canal viejo', () => {
    const anfitriona = new FakeChannel('ana');
    const code = create(anfitriona, '@ana', ana, 'approved');

    const primero = new FakeChannel('bob-1');
    join(primero, '@bob', code);
    admitir(anfitriona, anfitriona.last('join_request')!.id);

    const segundo = new FakeChannel('bob-2');
    join(segundo, '@bob', code);
    admitir(anfitriona, anfitriona.last('join_request')!.id);

    assert.equal(primero.closed?.code, 4003, 'un socket sin dueño no se deja abierto');
    assert.ok(segundo.last('welcome'));
    const bobs = anfitriona.last('room_state')?.members.filter((m) => m.alias === '@bob') ?? [];
    assert.equal(bobs.length, 1);
  });

  test('dos invitados sin firma no se borran de la cola', () => {
    const anfitriona = new FakeChannel('ana');
    const code = create(anfitriona, '@ana', ana, 'approved');

    const bob = new FakeChannel('bob');
    join(bob, '@bob', code);
    const solicitudDeBob = anfitriona.last('join_request')!.id;

    const carla = new FakeChannel('carla');
    join(carla, '@carla', code);

    assert.equal(anfitriona.all('join_request').length, 2);
    assert.equal(anfitriona.all('join_request_gone').length, 0, 'nadie desapareció de la cola');

    admitir(anfitriona, solicitudDeBob);
    assert.ok(bob.last('welcome'), 'su solicitud seguía viva');
  });

  test('quien recupera el mando recibe las solicitudes que ya esperaban', () => {
    const anfitriona = new FakeChannel('ana');
    const code = create(anfitriona, '@ana', ana, 'approved');

    const beto = new FakeChannel('beto');
    join(beto, '@beto', code, identity());
    admitir(anfitriona, anfitriona.last('join_request')!.id);

    const zoe = new FakeChannel('zoe');
    join(zoe, '@zoe', code, identity());
    const solicitud = anfitriona.last('join_request')!.id;

    hub.disconnect('ana');
    assert.equal(beto.last('join_request')?.id, solicitud, 'quien hereda ya lo recibía');

    const vuelve = new FakeChannel('ana-2');
    join(vuelve, '@ana', code, ana);

    assert.equal(vuelve.last('host_changed')?.reason, 'returned');
    assert.equal(vuelve.last('join_request')?.id, solicitud, 'recuperar el mando es recuperar la puerta');
  });

  test('desalojar al okupa que era anfitrión anuncia el mando nuevo', () => {
    const anfitriona = new FakeChannel('ana');
    const code = create(anfitriona, '@ana', ana);

    const bob = new FakeChannel('bob');
    join(bob, '@bob', code);
    const carla = new FakeChannel('carla');
    join(carla, '@carla', code);

    hub.disconnect('ana');
    assert.equal(carla.last('host_changed')?.host, '@bob', '@bob heredó por antigüedad');

    join(new FakeChannel('bob-firmado'), '@bob', code, identity());

    assert.equal(bob.closed?.code, 4007, 'el okupa sale');
    assert.equal(
      carla.last('host_changed')?.host,
      '@carla',
      'el mando cambió de manos y hay que decirlo',
    );
  });

  test('admitir sin firma no aprueba a todos los que no firman', () => {
    const anfitriona = new FakeChannel('ana');
    const code = create(anfitriona, '@ana', ana, 'approved');

    const bob = new FakeChannel('bob');
    join(bob, '@bob', code);
    admitir(anfitriona, anfitriona.last('join_request')!.id);

    const carla = new FakeChannel('carla');
    join(carla, '@carla', code);

    hub.disconnect('ana');

    const heredada = bob.last('join_request');
    assert.equal(heredada?.alias, '@carla');
    assert.equal(heredada?.knownAlias, undefined, 'nadie entró antes con la clave vacía');
  });

  test('el aprobado sin clave no entra directo la próxima vez', () => {
    const anfitriona = new FakeChannel('ana');
    const code = create(anfitriona, '@ana', ana, 'approved');

    const bob = new FakeChannel('bob');
    join(bob, '@bob', code);
    admitir(anfitriona, anfitriona.last('join_request')!.id);
    hub.disconnect('bob');

    const cualquiera = new FakeChannel('cualquiera');
    join(cualquiera, '@quien', code);

    assert.ok(cualquiera.last('waiting_approval'), 'no firmar no es un pase');
  });

  test('si el alias se ató mientras esperaba, admitirle no se salta la firma', () => {
    const anfitriona = new FakeChannel('ana');
    const code = create(anfitriona, '@ana', ana, 'approved');

    const extrano = new FakeChannel('extrano');
    join(extrano, '@carla', code);
    const solicitud = anfitriona.last('join_request')!.id;

    const carla = new FakeChannel('carla');
    join(carla, '@carla', code, identity());
    admitir(anfitriona, anfitriona.last('join_request')!.id);
    assert.equal(carla.last('welcome')?.verified, true);

    admitir(anfitriona, solicitud);

    assert.equal(extrano.closed?.code, 4007, 'el alias ya tiene dueña');
    assert.equal(carla.closed, undefined, 'y la dueña se queda');
  });
});
