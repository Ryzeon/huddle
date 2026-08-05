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

/** Una identidad de verdad: firma con Ed25519 y la verifica el adaptador real. */
function identity(): { pubkey: string; sign: (text: string) => string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string };
  return {
    pubkey: jwk.x,
    sign: (text) => sign(null, Buffer.from(text, 'utf8'), privateKey).toString('base64url'),
  };
}

describe('firmar el alias', () => {
  let now: number;
  let hub: HubService;
  let rooms: MemoryRooms;
  let ana: ReturnType<typeof identity>;
  let beto: ReturnType<typeof identity>;
  let seq: number;

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

  /** Abre el socket (recibe el reto) y devuelve el nonce. */
  const greet = (channel: FakeChannel): string => {
    hub.greet(channel);
    return channel.last('challenge')!.nonce;
  };

  const create = (channel: FakeChannel, alias: string, who?: ReturnType<typeof identity>) => {
    const nonce = greet(channel);
    const proof = who
      ? {
          pubkey: who.pubkey,
          sig: who.sign(identityProofText({ kind: 'create', room: '', alias, nonce })),
          nonce,
        }
      : undefined;
    hub.handle(channel, {
      t: 'create',
      v: PROTOCOL_VERSION,
      name: 'Equipo',
      alias,
      quotaRemaining: null,
      ...(proof && { proof }),
    });
    return channel.last('welcome')!.room;
  };

  const join = (
    channel: FakeChannel,
    alias: string,
    room: string,
    who?: ReturnType<typeof identity>,
    options: { viewer?: boolean; nonce?: string } = {},
  ) => {
    const nonce = options.nonce ?? greet(channel);
    const proof = who
      ? {
          pubkey: who.pubkey,
          sig: who.sign(
            identityProofText({ kind: 'join', room, alias, viewer: options.viewer, nonce }),
          ),
          nonce,
        }
      : undefined;
    hub.handle(channel, {
      t: 'join',
      v: PROTOCOL_VERSION,
      room,
      alias,
      quotaRemaining: null,
      ...(options.viewer !== undefined && { viewer: options.viewer }),
      ...(proof && { proof }),
    });
  };

  beforeEach(() => {
    now = 1_000_000;
    seq = 0;
    rooms = new MemoryRooms();
    hub = build();
    ana = identity();
    beto = identity();
  });

  test('quien firma sale verificado en el roster de los demás', () => {
    const anfitrion = new FakeChannel('host');
    const code = create(anfitrion, '@host');

    const canal = new FakeChannel('ana');
    join(canal, '@ana', code, ana);

    assert.equal(canal.last('welcome')?.verified, true);
    const enElRoster = anfitrion.last('room_state')?.members.find((m) => m.alias === '@ana');
    assert.equal(enElRoster?.verified, true);
    assert.equal(enElRoster?.key, ana.pubkey.slice(-8), 'la cola de la clave, no la clave');
    assert.equal(
      JSON.stringify(enElRoster).includes(ana.pubkey),
      false,
      'la clave entera no viaja en el roster',
    );
  });

  test('quien no firma entra, pero sin insignia', () => {
    const anfitrion = new FakeChannel('host');
    const code = create(anfitrion, '@host');

    const canal = new FakeChannel('ana');
    join(canal, '@ana', code);

    assert.equal(canal.last('welcome')?.verified, false);
    const enElRoster = anfitrion.last('room_state')?.members.find((m) => m.alias === '@ana');
    assert.equal(enElRoster?.verified, undefined, 'sin firma no hay insignia');
  });

  test('firmar el alias de otro te deja fuera con 4007', () => {
    const anfitrion = new FakeChannel('host');
    const code = create(anfitrion, '@host');
    join(new FakeChannel('ana'), '@ana', code, ana);

    const impostor = new FakeChannel('impostor');
    join(impostor, '@ana', code, beto);

    assert.equal(impostor.last('error')?.reason, 'identity_mismatch');
    assert.equal(impostor.closed?.code, 4007);
    assert.equal(impostor.last('welcome'), undefined);
  });

  test('el detalle del error dice las dos claves, para poder compararlas', () => {
    const anfitrion = new FakeChannel('host');
    const code = create(anfitrion, '@host');
    join(new FakeChannel('ana'), '@ana', code, ana);

    const impostor = new FakeChannel('impostor');
    join(impostor, '@ana', code, beto);

    const detalle = impostor.last('error')?.detail ?? '';
    assert.match(detalle, new RegExp(ana.pubkey.slice(-8)));
    assert.match(detalle, new RegExp(beto.pubkey.slice(-8)));
  });

  test('una prueba capturada no sirve en otra conexión', () => {
    const anfitrion = new FakeChannel('host');
    const code = create(anfitrion, '@host');

    const legitima = new FakeChannel('ana');
    const nonce = greet(legitima);
    const sig = ana.sign(identityProofText({ kind: 'join', room: code, alias: '@ana', nonce }));
    hub.handle(legitima, {
      t: 'join',
      v: PROTOCOL_VERSION,
      room: code,
      alias: '@ana',
      quotaRemaining: null,
      proof: { pubkey: ana.pubkey, sig, nonce },
    });
    assert.equal(legitima.last('welcome')?.verified, true);

    // El ladrón copia la prueba entera en su propia conexión, que tiene otro reto.
    const ladron = new FakeChannel('ladron');
    greet(ladron);
    hub.handle(ladron, {
      t: 'join',
      v: PROTOCOL_VERSION,
      room: code,
      alias: '@ana',
      quotaRemaining: null,
      proof: { pubkey: ana.pubkey, sig, nonce },
    });

    assert.equal(ladron.closed?.code, 4007, 'el nonce era de la otra conexión');
  });

  test('sin reto previo no se acepta ninguna prueba', () => {
    const anfitrion = new FakeChannel('host');
    const code = create(anfitrion, '@host');

    // Nunca se llamó a `greet`: no hay reto que consumir.
    const canal = new FakeChannel('ana');
    const nonce = 'inventado';
    hub.handle(canal, {
      t: 'join',
      v: PROTOCOL_VERSION,
      room: code,
      alias: '@ana',
      quotaRemaining: null,
      proof: {
        pubkey: ana.pubkey,
        sig: ana.sign(identityProofText({ kind: 'join', room: code, alias: '@ana', nonce })),
        nonce,
      },
    });

    assert.equal(canal.last('welcome')?.verified, false, 'no se puede verificar sin reto');
  });

  test('el reto es de un solo uso', () => {
    const anfitrion = new FakeChannel('host');
    const code = create(anfitrion, '@host');

    const canal = new FakeChannel('ana');
    const nonce = greet(canal);
    join(canal, '@ana', code, ana, { nonce });
    assert.equal(canal.last('welcome')?.verified, true);

    // Segundo join por el mismo canal, con el mismo reto: ya está gastado.
    const otro = new FakeChannel('ana-2');
    hub.handle(otro, {
      t: 'join',
      v: PROTOCOL_VERSION,
      room: code,
      alias: '@ana',
      quotaRemaining: null,
      proof: {
        pubkey: ana.pubkey,
        sig: ana.sign(identityProofText({ kind: 'join', room: code, alias: '@ana', nonce })),
        nonce,
      },
    });
    assert.equal(otro.closed?.code, 4007, 'ese reto ya no vale');
  });

  test('el okupa sale cuando llega quien firma ese alias', () => {
    const anfitrion = new FakeChannel('host');
    const code = create(anfitrion, '@host');

    const okupa = new FakeChannel('okupa');
    join(okupa, '@ana', code);
    assert.ok(okupa.last('welcome'), 'entró primero, sin firmar');

    const legitima = new FakeChannel('ana');
    join(legitima, '@ana', code, ana);

    assert.equal(okupa.last('room_closed')?.reason, 'identity_taken');
    assert.equal(okupa.closed?.code, 4007);
    assert.equal(legitima.last('welcome')?.verified, true);

    const alias = anfitrion.last('room_state')?.members.filter((m) => m.alias === '@ana') ?? [];
    assert.equal(alias.length, 1, 'no puede haber dos @ana, una de ellas okupa');
    assert.equal(alias[0]?.verified, true);
  });

  test('el vínculo sobrevive a la desconexión: el alias no se libera al irse', () => {
    const anfitrion = new FakeChannel('host');
    const code = create(anfitrion, '@host');

    join(new FakeChannel('ana'), '@ana', code, ana);
    hub.disconnect('ana');

    const aprovechado = new FakeChannel('otro');
    join(aprovechado, '@ana', code);

    assert.equal(aprovechado.closed?.code, 4007, 'esperar a que se vaya no da derecho al nombre');
  });

  test('el vínculo sobrevive al reinicio del hub', () => {
    const anfitrion = new FakeChannel('host');
    const code = create(anfitrion, '@host');
    join(new FakeChannel('ana'), '@ana', code, ana);

    const reiniciado = build();
    reiniciado.restore();
    hub = reiniciado;

    const aprovechado = new FakeChannel('otro');
    join(aprovechado, '@ana', code);
    assert.equal(aprovechado.closed?.code, 4007);

    const vuelve = new FakeChannel('ana-2');
    join(vuelve, '@ana', code, ana);
    assert.equal(vuelve.last('welcome')?.verified, true, 'con su clave vuelve a ser ella');
  });

  test('la misma clave con otro alias es otra persona, y se puede', () => {
    const anfitrion = new FakeChannel('host');
    const code = create(anfitrion, '@host');
    join(new FakeChannel('ana'), '@ana', code, ana);

    const conOtroNombre = new FakeChannel('ana-alias-2');
    join(conOtroNombre, '@anita', code, ana);

    assert.equal(conOtroNombre.last('welcome')?.verified, true);
  });

  test('cerrar la sala se lleva los vínculos', () => {
    const anfitrion = new FakeChannel('host');
    const code = create(anfitrion, '@host', ana);
    join(new FakeChannel('beto'), '@beto', code, beto);

    hub.handle(anfitrion, { t: 'close' });

    const nueva = new FakeChannel('host-2');
    const otroCodigo = create(nueva, '@host');
    const cualquiera = new FakeChannel('cualquiera');
    join(cualquiera, '@beto', otroCodigo);

    assert.ok(cualquiera.last('welcome'), 'los vínculos eran de aquella sala, no del hub');
  });

  test('quien crea la sala firmando queda verificado desde el principio', () => {
    const anfitrion = new FakeChannel('host');
    create(anfitrion, '@ana', ana);

    assert.equal(anfitrion.last('welcome')?.verified, true);
  });

  test('una firma de create no vale para entrar en la sala', () => {
    const anfitrion = new FakeChannel('host');
    const code = create(anfitrion, '@host');

    const canal = new FakeChannel('ana');
    const nonce = greet(canal);
    hub.handle(canal, {
      t: 'join',
      v: PROTOCOL_VERSION,
      room: code,
      alias: '@ana',
      quotaRemaining: null,
      proof: {
        pubkey: ana.pubkey,
        sig: ana.sign(identityProofText({ kind: 'create', room: '', alias: '@ana', nonce })),
        nonce,
      },
    });

    assert.equal(canal.last('welcome')?.verified, false, 'el kind ata la firma a su sitio');
  });

  test('la firma va atada a la sala: no vale en otra', () => {
    const uno = new FakeChannel('host-1');
    const primera = create(uno, '@host');
    const dos = new FakeChannel('host-2');
    const segunda = create(dos, '@host2');

    const canal = new FakeChannel('ana');
    const nonce = greet(canal);
    hub.handle(canal, {
      t: 'join',
      v: PROTOCOL_VERSION,
      room: segunda,
      alias: '@ana',
      quotaRemaining: null,
      proof: {
        pubkey: ana.pubkey,
        sig: ana.sign(identityProofText({ kind: 'join', room: primera, alias: '@ana', nonce })),
        nonce,
      },
    });

    assert.equal(canal.last('welcome')?.verified, false);
  });
});
