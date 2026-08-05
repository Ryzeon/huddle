import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { PROTOCOL_VERSION, identityProofText, type ServerMessage } from '@huddle/protocol';
import { HubService, DEFAULT_HUB_CONFIG } from './hub-service.js';
import { ed25519Verifier } from '../adapters/outbound/ed25519.js';
import type { MemberChannelPort, TimerPort, TranscriptStorePort } from './ports/member-channel.js';

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
}

const noTranscripts: TranscriptStorePort = {
  append: () => undefined,
  read: () => [],
  purge: () => 0,
  rename: () => true,
};

function identity(): { pubkey: string; sign: (text: string) => string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string };
  return {
    pubkey: jwk.x,
    sign: (text) => sign(null, Buffer.from(text, 'utf8'), privateKey).toString('base64url'),
  };
}

describe('salas con aprobación', () => {
  let now: number;
  let timers: ManualTimers;
  let hub: HubService;
  let seq: number;
  let ana: ReturnType<typeof identity>;
  let beto: ReturnType<typeof identity>;

  const greet = (channel: FakeChannel): string => {
    hub.greet(channel);
    return channel.last('challenge')!.nonce;
  };

  const create = (
    channel: FakeChannel,
    alias: string,
    who?: ReturnType<typeof identity>,
    policy?: 'approved',
  ) => {
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
  ) => {
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

  beforeEach(() => {
    now = 1_000_000;
    seq = 0;
    timers = new ManualTimers();
    ana = identity();
    beto = identity();
    hub = new HubService(
      {
        clock: { now: () => now },
        timers,
        transcripts: noTranscripts,
        verifier: ed25519Verifier,
        generateCode: () => `SALA${++seq}-CODIG`,
      },
      DEFAULT_HUB_CONFIG,
    );
  });

  test('una sala abierta deja entrar igual que siempre', () => {
    const anfitrion = new FakeChannel('ana');
    const code = create(anfitrion, '@ana', ana);

    const canal = new FakeChannel('beto');
    join(canal, '@beto', code, beto);

    assert.ok(canal.last('welcome'), 'sin política, el código sigue siendo la llave');
    assert.equal(canal.last('waiting_approval'), undefined);
  });

  test('en una sala con aprobación, quien llega se queda en la puerta', () => {
    const anfitrion = new FakeChannel('ana');
    const code = create(anfitrion, '@ana', ana, 'approved');

    const canal = new FakeChannel('beto');
    join(canal, '@beto', code, beto);

    assert.equal(canal.last('welcome'), undefined, 'todavía no está dentro');
    const espera = canal.last('waiting_approval');
    assert.equal(espera?.you, '@beto');
    assert.equal(espera?.key, beto.pubkey.slice(-8), 'para poder dictársela al anfitrión');
  });

  test('el que espera no sale en el roster ni recibe el historial', () => {
    const anfitrion = new FakeChannel('ana');
    const code = create(anfitrion, '@ana', ana, 'approved');
    join(new FakeChannel('beto'), '@beto', code, beto);

    const roster = anfitrion.last('room_state')?.members ?? anfitrion.last('welcome')!.members;
    assert.equal(roster.some((m) => m.alias === '@beto'), false);
    assert.equal(hub.stats().members, 1, 'esperar no es estar');
  });

  test('el anfitrión recibe la solicitud con alias y cola de clave', () => {
    const anfitrion = new FakeChannel('ana');
    const code = create(anfitrion, '@ana', ana, 'approved');
    join(new FakeChannel('beto'), '@beto', code, beto);

    const solicitud = anfitrion.last('join_request');
    assert.equal(solicitud?.alias, '@beto');
    assert.equal(solicitud?.key, beto.pubkey.slice(-8));
  });

  test('aprobar mete a la persona en la sala', () => {
    const anfitrion = new FakeChannel('ana');
    const code = create(anfitrion, '@ana', ana, 'approved');
    const canal = new FakeChannel('beto');
    join(canal, '@beto', code, beto);

    const id = anfitrion.last('join_request')!.id;
    hub.handle(anfitrion, { t: 'admit', id });

    assert.equal(canal.last('welcome')?.you, '@beto');
    assert.equal(canal.last('welcome')?.verified, true);
    assert.equal(hub.stats().members, 2);
    assert.equal(anfitrion.last('join_request_gone')?.reason, 'resolved');
  });

  test('rechazar cierra con 4008 y no mete a nadie', () => {
    const anfitrion = new FakeChannel('ana');
    const code = create(anfitrion, '@ana', ana, 'approved');
    const canal = new FakeChannel('beto');
    join(canal, '@beto', code, beto);

    const id = anfitrion.last('join_request')!.id;
    hub.handle(anfitrion, { t: 'deny', id, reason: 'a ti no' });

    assert.equal(canal.last('error')?.reason, 'denied_by_owner');
    assert.equal(canal.last('error')?.detail, 'a ti no');
    assert.equal(canal.closed?.code, 4008);
    assert.equal(hub.stats().members, 1);
  });

  test('quien no es anfitrión no abre la puerta', () => {
    const anfitrion = new FakeChannel('ana');
    const code = create(anfitrion, '@ana', ana, 'approved');
    const dentro = new FakeChannel('beto');
    join(dentro, '@beto', code, beto);
    hub.handle(anfitrion, { t: 'admit', id: anfitrion.last('join_request')!.id });

    const tercero = new FakeChannel('caro');
    join(tercero, '@caro', code, identity());
    const id = anfitrion.last('join_request')!.id;

    hub.handle(dentro, { t: 'admit', id });

    assert.equal(dentro.last('error')?.reason, 'denied_by_owner');
    assert.equal(tercero.last('welcome'), undefined, '@caro sigue en la puerta');
  });

  test('el dueño entra en su propia sala sin pedir permiso', () => {
    const anfitrion = new FakeChannel('ana');
    const code = create(anfitrion, '@ana', ana, 'approved');

    // Recarga del portal: la dueña vuelve con su clave.
    const otraVez = new FakeChannel('ana-2');
    join(otraVez, '@ana', code, ana);

    assert.ok(otraVez.last('welcome'), 'nadie pide permiso para entrar en lo suyo');
  });

  test('a quien ya aprobaron entra directo la próxima vez', () => {
    const anfitrion = new FakeChannel('ana');
    const code = create(anfitrion, '@ana', ana, 'approved');
    const primera = new FakeChannel('beto');
    join(primera, '@beto', code, beto);
    hub.handle(anfitrion, { t: 'admit', id: anfitrion.last('join_request')!.id });
    hub.disconnect('beto');

    const segunda = new FakeChannel('beto-2');
    join(segunda, '@beto', code, beto);

    assert.ok(segunda.last('welcome'), 'aprobar una vez es aprobar');
    assert.equal(segunda.last('waiting_approval'), undefined);
  });

  test('con remember=false hay que volver a aprobarle', () => {
    const anfitrion = new FakeChannel('ana');
    const code = create(anfitrion, '@ana', ana, 'approved');
    const primera = new FakeChannel('beto');
    join(primera, '@beto', code, beto);
    hub.handle(anfitrion, { t: 'admit', id: anfitrion.last('join_request')!.id, remember: false });
    hub.disconnect('beto');

    const segunda = new FakeChannel('beto-2');
    join(segunda, '@beto', code, beto);

    assert.ok(segunda.last('waiting_approval'), 'era un pase de un solo uso');
  });

  test('la aprobación es de la clave con SU alias, no del alias', () => {
    const anfitrion = new FakeChannel('ana');
    const code = create(anfitrion, '@ana', ana, 'approved');
    const primera = new FakeChannel('beto');
    join(primera, '@beto', code, beto);
    hub.handle(anfitrion, { t: 'admit', id: anfitrion.last('join_request')!.id });
    hub.disconnect('beto');

    // La misma clave, otro nombre: aprobar a @beto no es darle la sala entera.
    const conOtroAlias = new FakeChannel('beto-3');
    join(conOtroAlias, '@jefe', code, beto);

    assert.ok(conOtroAlias.last('waiting_approval'), 'ese alias no estaba aprobado');
  });

  test('expulsar revoca la aprobación: no vuelve a entrar solo', () => {
    const anfitrion = new FakeChannel('ana');
    const code = create(anfitrion, '@ana', ana, 'approved');
    const canal = new FakeChannel('beto');
    join(canal, '@beto', code, beto);
    hub.handle(anfitrion, { t: 'admit', id: anfitrion.last('join_request')!.id });

    hub.handle(anfitrion, { t: 'kick', alias: '@beto' });
    hub.disconnect('beto');

    const vuelve = new FakeChannel('beto-2');
    join(vuelve, '@beto', code, beto);

    assert.ok(vuelve.last('waiting_approval'), 'sin esto, expulsar sería decorativo');
  });

  test('sin firma te quedas en la puerta aunque el alias esté libre', () => {
    const anfitrion = new FakeChannel('ana');
    const code = create(anfitrion, '@ana', ana, 'approved');

    const canal = new FakeChannel('anonimo');
    join(canal, '@anonimo', code);

    assert.ok(canal.last('waiting_approval'), 'aprobar a quien no firma no aprueba nada');
  });

  test('la espera caduca en vez de dejar el socket colgado', () => {
    const anfitrion = new FakeChannel('ana');
    const code = create(anfitrion, '@ana', ana, 'approved');
    const canal = new FakeChannel('beto');
    join(canal, '@beto', code, beto);

    timers.advance(DEFAULT_HUB_CONFIG.approvalTimeoutMs + 1);

    assert.equal(canal.closed?.code, 4008);
    assert.equal(anfitrion.last('join_request_gone')?.reason, 'expired');
  });

  test('si el que espera se cansa, la solicitud desaparece del anfitrión', () => {
    const anfitrion = new FakeChannel('ana');
    const code = create(anfitrion, '@ana', ana, 'approved');
    const canal = new FakeChannel('beto');
    join(canal, '@beto', code, beto);
    const id = anfitrion.last('join_request')!.id;

    hub.disconnect('beto');

    const gone = anfitrion.last('join_request_gone');
    assert.equal(gone?.id, id);
    assert.equal(gone?.reason, 'left');
  });

  test('quien espera no puede preguntar ni hablar', () => {
    const anfitrion = new FakeChannel('ana');
    const code = create(anfitrion, '@ana', ana, 'approved');
    const canal = new FakeChannel('beto');
    join(canal, '@beto', code, beto);

    hub.handle(canal, { t: 'ask', id: 'q1', to: '@ana', q: 'hola', ttl: 60 });

    assert.equal(anfitrion.last('request'), undefined);
    assert.match(canal.last('error')?.detail ?? '', /esperando/);
    assert.doesNotMatch(canal.last('error')?.detail ?? '', /join/, 'ya mandó join');
  });

  test('quien hereda el mando recibe las solicitudes que ya esperaban', () => {
    const anfitrion = new FakeChannel('ana');
    const code = create(anfitrion, '@ana', ana, 'approved');

    const segunda = new FakeChannel('beto');
    join(segunda, '@beto', code, beto);
    hub.handle(anfitrion, { t: 'admit', id: anfitrion.last('join_request')!.id });

    const tercera = new FakeChannel('caro');
    join(tercera, '@caro', code, identity());
    const id = anfitrion.last('join_request')!.id;

    hub.disconnect('ana');

    const heredado = segunda.last('join_request');
    assert.equal(heredado?.id, id, 'sin el backlog, @caro esperaría a nadie');
  });

  test('si la sala se queda vacía, no se deja a nadie esperando', () => {
    const anfitrion = new FakeChannel('ana');
    const code = create(anfitrion, '@ana', ana, 'approved');
    const canal = new FakeChannel('beto');
    join(canal, '@beto', code, beto);

    hub.disconnect('ana');

    assert.equal(canal.last('room_closed')?.reason, 'empty');
    assert.ok(canal.closed, 'esperar a una sala vacía es esperar a nadie');
  });

  test('rotar el código echa también a los que esperan', () => {
    const anfitrion = new FakeChannel('ana');
    const code = create(anfitrion, '@ana', ana, 'approved');
    const canal = new FakeChannel('beto');
    join(canal, '@beto', code, beto);

    hub.handle(anfitrion, { t: 'rotate', id: 'r1' });

    assert.equal(canal.last('room_closed')?.reason, 'code_rotated');
    assert.equal(canal.closed?.code, 4006);
    assert.equal(anfitrion.last('join_request_gone')?.reason, 'room_closed');
  });

  test('tras rotar, el aprobado entra directo con el código nuevo', () => {
    const anfitrion = new FakeChannel('ana');
    const code = create(anfitrion, '@ana', ana, 'approved');
    const canal = new FakeChannel('beto');
    join(canal, '@beto', code, beto);
    hub.handle(anfitrion, { t: 'admit', id: anfitrion.last('join_request')!.id });

    hub.handle(anfitrion, { t: 'rotate', id: 'r1' });
    const nuevo = anfitrion.last('room_code')!.room;

    const vuelve = new FakeChannel('beto-2');
    join(vuelve, '@beto', nuevo, beto);

    assert.ok(vuelve.last('welcome'), 'rotar cambia la llave, no la lista de invitados');
  });

  test('insistir no te pone dos veces en la cola', () => {
    const anfitrion = new FakeChannel('ana');
    const code = create(anfitrion, '@ana', ana, 'approved');

    join(new FakeChannel('beto-1'), '@beto', code, beto);
    join(new FakeChannel('beto-2'), '@beto', code, beto);

    const vivas = anfitrion.all('join_request').length;
    const retiradas = anfitrion.all('join_request_gone').length;
    assert.equal(vivas - retiradas, 2, 'llegan dos avisos, pero…');
    assert.equal(
      anfitrion.last('join_request')!.id !== anfitrion.all('join_request')[0]!.id,
      true,
    );
  });

  test('aprobar una solicitud que ya no existe se dice, no se traga', () => {
    const anfitrion = new FakeChannel('ana');
    create(anfitrion, '@ana', ana, 'approved');

    hub.handle(anfitrion, { t: 'admit', id: 'inventado' });

    assert.equal(anfitrion.last('error')?.reason, 'bad_request');
  });
});
