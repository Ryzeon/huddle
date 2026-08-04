import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { PROTOCOL_VERSION, type ServerMessage } from '@huddle/protocol';
import { HubService } from './hub-service.js';
import type { MemberChannelPort, TimerPort } from './ports/member-channel.js';
import { generateRoomCode, isValidRoomCode, normalizeRoomCode } from '../domain/room-code.js';

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
const noTranscripts = { append: () => undefined, read: () => [], purge: () => 0 };

describe('sala con anfitrión', () => {
  let now: number;
  let hub: HubService;
  let code: string;

  const create = (channel: FakeChannel, alias: string, name = 'Equipo Backend') => {
    hub.handle(channel, {
      t: 'create',
      v: PROTOCOL_VERSION,
      name,
      alias,
      card: { repo: 'repo', dirs: [] },
      quotaRemaining: 10,
    });
    return channel.last('welcome')!.room;
  };

  const join = (channel: FakeChannel, alias: string, tag?: string) => {
    hub.handle(channel, {
      t: 'join',
      v: PROTOCOL_VERSION,
      room: code,
      alias,
      tag,
      card: { repo: 'repo', dirs: [] },
      quotaRemaining: 10,
    });
  };

  beforeEach(() => {
    now = 1_000_000;
    hub = new HubService({
      clock: { now: () => now },
      timers: noTimers,
      transcripts: noTranscripts,
    });
    const host = new FakeChannel('host-init');
    code = create(host, '@ana');
  });

  test('crear devuelve un código válido y el nombre puesto', () => {
    const channel = new FakeChannel('c');
    hub.handle(channel, {
      t: 'create',
      v: PROTOCOL_VERSION,
      name: 'Pagos',
      alias: '@zoe',
      quotaRemaining: null,
    });

    const welcome = channel.last('welcome');
    assert.ok(isValidRoomCode(welcome!.room), `código raro: ${welcome!.room}`);
    assert.equal(welcome?.roomName, 'Pagos');
    assert.equal(welcome?.host, '@zoe', 'quien crea la sala manda');
  });

  test('el código es la llave: sin él no se entra', () => {
    const intruso = new FakeChannel('x');
    hub.handle(intruso, {
      t: 'join',
      v: PROTOCOL_VERSION,
      room: 'XXXXX-XXXXX',
      alias: '@intruso',
      quotaRemaining: null,
    });

    assert.match(intruso.last('error')?.detail ?? '', /no existe/);
    assert.equal(intruso.closed?.code, 4001);
  });

  test('el código se acepta en minúsculas y con espacios', () => {
    const channel = new FakeChannel('b');
    hub.handle(channel, {
      t: 'join',
      v: PROTOCOL_VERSION,
      room: ` ${code.toLowerCase()} `,
      alias: '@beto',
      quotaRemaining: null,
    });

    assert.equal(channel.last('welcome')?.room, code);
  });

  test('quien entra después ve quién es el anfitrión', () => {
    const beto = new FakeChannel('b');
    join(beto, '@beto');
    assert.equal(beto.last('welcome')?.host, '@ana');
  });

  test('el anfitrión puede expulsar', () => {
    const beto = new FakeChannel('b');
    const ana = new FakeChannel('host-init');
    join(beto, '@beto');

    hub.handle(ana, { t: 'kick', alias: '@beto' });

    assert.equal(beto.last('room_closed')?.reason, 'kicked');
    assert.equal(beto.closed?.code, 4003, 'cierre terminal: no debe reconectar');
  });

  test('quien no es anfitrión no puede expulsar', () => {
    const beto = new FakeChannel('b');
    const caro = new FakeChannel('c');
    join(beto, '@beto');
    join(caro, '@caro');

    hub.handle(beto, { t: 'kick', alias: '@caro' });

    assert.equal(beto.last('error')?.reason, 'denied_by_owner');
    assert.equal(caro.closed, undefined, '@caro debería seguir dentro');
  });

  test('expulsar echa todos los tags de esa persona', () => {
    const uno = new FakeChannel('b1');
    const dos = new FakeChannel('b2');
    const ana = new FakeChannel('host-init');
    join(uno, '@beto', 'api');
    join(dos, '@beto', 'web');

    hub.handle(ana, { t: 'kick', alias: '@beto' });

    assert.equal(uno.closed?.code, 4003);
    assert.equal(dos.closed?.code, 4003, 'dejarle un tag dentro no es expulsarlo');
  });

  test('el anfitrión no puede expulsarse a sí mismo', () => {
    const ana = new FakeChannel('host-init');
    hub.handle(ana, { t: 'kick', alias: '@ana' });
    assert.match(ana.last('error')?.detail ?? '', /a ti mismo/);
  });

  test('si el anfitrión se va, hereda el más antiguo', () => {
    const beto = new FakeChannel('b');
    const caro = new FakeChannel('c');
    now = 2_000;
    join(beto, '@beto');
    now = 3_000;
    join(caro, '@caro');

    hub.disconnect('host-init');

    assert.equal(beto.last('host_changed')?.host, '@beto', 'entró antes que @caro');
    assert.equal(caro.last('host_changed')?.reason, 'left');
  });

  test('la sucesión sigue hasta que solo queda uno', () => {
    const beto = new FakeChannel('b');
    const caro = new FakeChannel('c');
    now = 2_000;
    join(beto, '@beto');
    now = 3_000;
    join(caro, '@caro');

    hub.disconnect('host-init'); // manda @beto
    hub.disconnect('b'); // manda @caro

    assert.equal(caro.last('host_changed')?.host, '@caro');
    assert.equal(hub.stats().members, 1);
  });

  test('cuando sale el último, la sala desaparece', () => {
    assert.equal(hub.stats().rooms, 1);
    hub.disconnect('host-init');
    assert.equal(hub.stats().rooms, 0, 'sin nadie dentro no hay sala que mantener');
  });

  test('perder un tag no te quita el mando si te queda otro', () => {
    const api = new FakeChannel('a-api');
    const beto = new FakeChannel('b');
    join(api, '@ana', 'api');
    now = 5_000;
    join(beto, '@beto');

    hub.disconnect('a-api'); // @ana sigue con su conexión principal

    assert.equal(beto.last('host_changed'), undefined, '@ana no perdió el mando');
  });

  test('reconectar no te manda al final de la línea de sucesión', () => {
    const beto = new FakeChannel('b');
    const caro = new FakeChannel('c');
    now = 2_000;
    join(beto, '@beto');
    now = 3_000;
    join(caro, '@caro');

    // @beto se reconecta más tarde: conserva su antigüedad original.
    now = 9_000;
    const betoOtraVez = new FakeChannel('b2');
    join(betoOtraVez, '@beto');

    hub.disconnect('host-init');

    assert.equal(betoOtraVez.last('host_changed')?.host, '@beto');
  });
});

describe('generateRoomCode', () => {
  test('produce códigos con el formato esperado', () => {
    for (let i = 0; i < 50; i++) {
      assert.ok(isValidRoomCode(generateRoomCode()), 'código inválido generado');
    }
  });

  test('no repite en 500 intentos', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) seen.add(generateRoomCode());
    assert.equal(seen.size, 500);
  });

  test('evita caracteres que se confunden al dictar', () => {
    const codes = Array.from({ length: 200 }, () => generateRoomCode()).join('');
    for (const confusing of ['O', '0', 'I', '1', 'L']) {
      assert.ok(!codes.includes(confusing), `${confusing} se presta a error al dictarlo`);
    }
  });

  test('normalizeRoomCode tolera minúsculas y espacios', () => {
    assert.equal(normalizeRoomCode(' bcdfg-hjkmn '), 'BCDFG-HJKMN');
  });
});
