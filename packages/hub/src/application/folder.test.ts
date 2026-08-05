import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { PROTOCOL_VERSION, type ServerMessage } from '@huddle/protocol';
import { HubService, DEFAULT_HUB_CONFIG } from './hub-service.js';
import type { FolderFile } from '../domain/folder.js';
import type { MemberChannelPort, TimerPort } from './ports/member-channel.js';

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

  count(type: ServerMessage['t']): number {
    return this.sent.filter((message) => message.t === type).length;
  }
}

const noTimers: TimerPort = { schedule: () => () => undefined };

/** Aquí nadie firma nada. */
const rejectEverything = { verify: () => false };

const DAY = 24 * 60 * 60 * 1000;

describe('la carpeta de la sala', () => {
  let clockNow: number;
  let hub: HubService;
  let roomCode: string;
  let codeSeq = 0;
  let disco: Map<string, FolderFile[]>;

  const create = (channel: FakeChannel, alias: string, extra: Record<string, unknown> = {}) => {
    hub.handle(channel, {
      t: 'create',
      v: PROTOCOL_VERSION,
      name: 'Equipo',
      alias,
      card: { repo: 'facturacion', dirs: [], keywords: ['facturacion', 'puertos'] },
      quotaRemaining: 10,
      ...extra,
    } as never);
    roomCode = channel.last('welcome')?.room ?? '';
  };

  const join = (channel: FakeChannel, alias: string) => {
    hub.handle(channel, {
      t: 'join',
      v: PROTOCOL_VERSION,
      room: roomCode,
      alias,
      card: { repo: 'web', dirs: [] },
      quotaRemaining: 10,
    });
  };

  beforeEach(() => {
    clockNow = 1_000_000;
    roomCode = '';
    disco = new Map();
    hub = new HubService(
      {
        clock: { now: () => clockNow },
        timers: noTimers,
        transcripts: { append: () => undefined, read: () => [], purge: () => 0, rename: () => true },
        folders: {
          read: (code) => disco.get(code) ?? [],
          write: (code, files) => void disco.set(code, [...files]),
          purge: (code) => void disco.delete(code),
          rename: (from, to) => {
            const files = disco.get(from);
            if (files) {
              disco.set(to, files);
              disco.delete(from);
            }
            return true;
          },
        },
        verifier: rejectEverything,
        generateCode: () => `TEST${++codeSeq}-ROOM1`,
      },
      DEFAULT_HUB_CONFIG,
    );
  });

  test('lo que escribe uno le llega a todos', () => {
    const ana = new FakeChannel('a');
    const beto = new FakeChannel('b');
    create(ana, '@ana');
    join(beto, '@beto');

    hub.handle(ana, { t: 'folder_put', id: 'f1', path: 'notas/api.md', text: '# API' });

    const estado = beto.last('folder_state');
    assert.equal(estado?.entries.length, 1);
    assert.equal(estado?.entries[0]?.path, 'notas/api.md');
    assert.equal(estado?.entries[0]?.by, '@ana');
    assert.equal(estado?.write, 'all');
  });

  test('el contenido no viaja en el estado: hay que pedirlo', () => {
    const ana = new FakeChannel('a');
    create(ana, '@ana');
    hub.handle(ana, { t: 'folder_put', id: 'f1', path: 'notas/api.md', text: 'secreto a voces' });

    assert.equal(JSON.stringify(ana.last('folder_state')).includes('secreto'), false);

    hub.handle(ana, { t: 'folder_get', id: 'g1', path: 'notas/api.md' });
    assert.equal(ana.last('folder_file')?.text, 'secreto a voces');
  });

  test('quien entra se encuentra la carpeta puesta', () => {
    const ana = new FakeChannel('a');
    create(ana, '@ana');
    hub.handle(ana, { t: 'folder_put', id: 'f1', path: 'notas/api.md', text: '# API' });

    const beto = new FakeChannel('b');
    join(beto, '@beto');

    assert.equal(beto.last('folder_state')?.entries.length, 1);
  });

  test('pedir un archivo que no existe se contesta, no se ignora', () => {
    const ana = new FakeChannel('a');
    create(ana, '@ana');

    hub.handle(ana, { t: 'folder_get', id: 'g1', path: 'notas/fantasma.md' });

    assert.equal(ana.last('error')?.id, 'g1');
    assert.match(ana.last('error')?.detail ?? '', /fantasma/);
  });

  test('con write: host, los demás no escriben', () => {
    const ana = new FakeChannel('a');
    const beto = new FakeChannel('b');
    create(ana, '@ana', { folderWrite: 'host' });
    join(beto, '@beto');

    hub.handle(beto, { t: 'folder_put', id: 'f1', path: 'notas/mia.md', text: 'x' });

    assert.equal(beto.last('error')?.reason, 'denied_by_owner');
    assert.equal(beto.count('folder_state'), 0);

    hub.handle(ana, { t: 'folder_put', id: 'f2', path: 'notas/suya.md', text: 'x' });
    assert.equal(beto.last('folder_state')?.entries.length, 1);
  });

  test('borrar difunde, y borrar lo que no está avisa', () => {
    const ana = new FakeChannel('a');
    create(ana, '@ana');
    hub.handle(ana, { t: 'folder_put', id: 'f1', path: 'notas/api.md', text: 'x' });

    hub.handle(ana, { t: 'folder_drop', id: 'd1', path: 'notas/api.md' });
    assert.equal(ana.last('folder_state')?.entries.length, 0);

    hub.handle(ana, { t: 'folder_drop', id: 'd2', path: 'notas/api.md' });
    assert.equal(ana.last('error')?.id, 'd2');
  });

  test('un cliente en bucle no machaca a la sala a difusiones', () => {
    const ana = new FakeChannel('a');
    create(ana, '@ana');

    for (let i = 0; i < 40; i++) {
      hub.handle(ana, { t: 'folder_put', id: `f${i}`, path: `notas/${i}.md`, text: 'x' });
    }

    assert.equal(ana.last('error')?.reason, 'rate_limited');
    assert.ok(ana.count('folder_state') <= 20, 'el tope corta antes de difundir');

    // Y con el tiempo se repone: no es un castigo, es un freno.
    clockNow += 60_000;
    hub.handle(ana, { t: 'folder_put', id: 'ff', path: 'notas/otra.md', text: 'x' });
    assert.equal(ana.last('folder_ok')?.path, 'notas/otra.md');
  });

  test('la carpeta sobrevive a un reinicio del hub', () => {
    const ana = new FakeChannel('a');
    create(ana, '@ana');
    hub.handle(ana, { t: 'folder_put', id: 'f1', path: 'notas/api.md', text: '# API' });

    assert.ok(disco.get(roomCode), 'debería haberse escrito a disco al vuelo');
  });

  test('cerrar la sala se lleva la carpeta', () => {
    const ana = new FakeChannel('a');
    create(ana, '@ana');
    hub.handle(ana, { t: 'folder_put', id: 'f1', path: 'notas/api.md', text: 'x' });

    hub.handle(ana, { t: 'close' });

    assert.equal(disco.has(roomCode), false);
  });

  test('rotar el código se lleva la carpeta con él', () => {
    const ana = new FakeChannel('a');
    create(ana, '@ana');
    hub.handle(ana, { t: 'folder_put', id: 'f1', path: 'notas/api.md', text: 'x' });
    const anterior = roomCode;

    hub.handle(ana, { t: 'rotate', id: 'r1' });
    const nuevo = ana.last('room_code')?.room ?? '';

    assert.notEqual(nuevo, anterior);
    assert.equal(disco.has(anterior), false, 'la carpeta no se queda en el código viejo');
    assert.equal(disco.get(nuevo)?.length, 1);
  });

  test('una sala con carpeta no se tira aunque se vaya el último', () => {
    const ana = new FakeChannel('a');
    create(ana, '@ana');
    hub.handle(ana, { t: 'folder_put', id: 'f1', path: 'notas/api.md', text: 'x' });

    hub.disconnect('a');

    assert.equal(hub.stats().rooms, 1);
  });

  test('pero la retención se la lleva igual que al historial', () => {
    const ana = new FakeChannel('a');
    create(ana, '@ana');
    hub.handle(ana, { t: 'folder_put', id: 'f1', path: 'notas/api.md', text: 'x' });
    hub.disconnect('a');

    clockNow += 40 * DAY;
    hub.purgeExpired();

    assert.equal(hub.stats().rooms, 0, 'una carpeta vieja no ancla la sala para siempre');
    assert.equal(disco.has(roomCode), false);
  });
});

describe('la memoria de la sala', () => {
  let clockNow: number;
  let hub: HubService;
  let roomCode: string;
  let codeSeq = 0;

  const responder = (ana: FakeChannel, beto: FakeChannel, question: string) => {
    hub.handle(ana, { t: 'ask', id: 'q1', to: '@beto', q: question, ttl: 60 });
    hub.handle(beto, {
      t: 'result',
      id: 'q1',
      answer: 'En el 9931.',
      sources: [{ file: 'src/server.ts', line: 2 }],
      confidence: 'high',
      elapsedMs: 1200,
      cached: false,
    });
  };

  const arrancar = (extra: Record<string, unknown> = {}) => {
    const ana = new FakeChannel('a');
    const beto = new FakeChannel('b');
    hub.handle(ana, {
      t: 'create',
      v: PROTOCOL_VERSION,
      name: 'Equipo',
      alias: '@ana',
      card: { repo: 'web', dirs: [] },
      quotaRemaining: 10,
      ...extra,
    } as never);
    roomCode = ana.last('welcome')?.room ?? '';
    hub.handle(beto, {
      t: 'join',
      v: PROTOCOL_VERSION,
      room: roomCode,
      alias: '@beto',
      card: { repo: 'facturacion', dirs: [], keywords: ['facturacion', 'puertos'] },
      quotaRemaining: 10,
    });
    return { ana, beto };
  };

  beforeEach(() => {
    clockNow = Date.UTC(2026, 7, 5, 12, 0);
    roomCode = '';
    hub = new HubService({
      clock: { now: () => clockNow },
      timers: noTimers,
      transcripts: { append: () => undefined, read: () => [], purge: () => 0, rename: () => true },
      verifier: rejectEverything,
      generateCode: () => `TEST${++codeSeq}-ROOM1`,
    });
  });

  test('cada respuesta deja una nota, su tema y su persona', () => {
    const { ana, beto } = arrancar();
    responder(ana, beto, '¿En qué puerto corre el servicio de facturación?');

    const rutas = (ana.last('folder_state')?.entries ?? []).map((entry) => entry.path);

    assert.ok(
      rutas.some((path) => path.startsWith('respuestas/2026-08-05-beto-')),
      `esperaba una nota de respuesta en ${rutas.join(', ')}`,
    );
    assert.ok(rutas.includes('temas/facturacion.md'));
    assert.ok(rutas.includes('gente/beto.md'));
    assert.ok(rutas.includes('README.md'), 'la carpeta se explica sola la primera vez');
  });

  test('el README aparece aunque ya hubiera notas escritas a mano', () => {
    const { ana, beto } = arrancar();
    hub.handle(ana, { t: 'folder_put', id: 'f1', path: 'notas/mia.md', text: 'x' });
    responder(ana, beto, '¿En qué puerto corre facturación?');

    const rutas = (ana.last('folder_state')?.entries ?? []).map((entry) => entry.path);
    assert.ok(rutas.includes('README.md'));
  });

  test('la nota trae la respuesta y sus fuentes', () => {
    const { ana, beto } = arrancar();
    responder(ana, beto, '¿En qué puerto corre facturación?');

    const nota = (ana.last('folder_state')?.entries ?? []).find((entry) =>
      entry.path.startsWith('respuestas/'),
    );
    hub.handle(ana, { t: 'folder_get', id: 'g1', path: nota!.path });

    const texto = ana.last('folder_file')?.text ?? '';
    assert.match(texto, /En el 9931\./);
    assert.match(texto, /`src\/server\.ts:2`/);
    assert.match(texto, /\[\[gente\/ana\]\]/);
    assert.match(texto, /\[\[temas\/facturacion\]\]/);
  });

  test('dos respuestas del mismo tema cuelgan del mismo nodo', () => {
    const { ana, beto } = arrancar();
    responder(ana, beto, '¿En qué puerto corre facturación?');
    // Con la misma palabra, no una parecida: el stem del hub solo iguala
    // plurales, así que "factura" y "facturación" son términos distintos —lo
    // mismo que ya le pasa a `@auto` al rutear.
    hub.handle(ana, { t: 'ask', id: 'q2', to: '@beto', q: '¿quién lanza la facturación?', ttl: 60 });
    hub.handle(beto, {
      t: 'result',
      id: 'q2',
      answer: 'El worker.',
      sources: [{ file: 'src/worker.ts' }],
      confidence: 'high',
      elapsedMs: 900,
      cached: false,
    });

    hub.handle(ana, { t: 'folder_get', id: 'g1', path: 'temas/facturacion.md' });
    const nodo = ana.last('folder_file')?.text ?? '';

    assert.equal(nodo.split('- [[respuestas/').length - 1, 2, `el nodo debería listar dos: ${nodo}`);
  });

  test('con folderMemory: false no se escribe nada', () => {
    const { ana, beto } = arrancar({ folderMemory: false });
    responder(ana, beto, '¿En qué puerto corre facturación?');

    assert.equal(ana.last('folder_state'), undefined);
  });

  test('una respuesta fallida no se recuerda', () => {
    const { ana, beto } = arrancar();
    hub.handle(ana, { t: 'ask', id: 'q1', to: '@beto', q: '¿y esto?', ttl: 60 });
    hub.handle(beto, { t: 'error', id: 'q1', reason: 'agent_failed', detail: 'se cayó' });

    assert.equal(ana.last('folder_state'), undefined);
  });
});

describe('vaciar un zip o una carpeta entera', () => {
  let clockNow: number;
  let hub: HubService;
  let codeSeq = 0;

  const crear = (channel: FakeChannel) => {
    hub.handle(channel, {
      t: 'create',
      v: PROTOCOL_VERSION,
      name: 'Equipo',
      alias: '@ana',
      card: { repo: 'web', dirs: [] },
      quotaRemaining: 10,
    });
  };

  beforeEach(() => {
    clockNow = 1_000_000;
    hub = new HubService({
      clock: { now: () => clockNow },
      timers: noTimers,
      transcripts: { append: () => undefined, read: () => [], purge: () => 0, rename: () => true },
      verifier: rejectEverything,
      generateCode: () => `TEST${++codeSeq}-ROOM1`,
    });
  });

  /**
   * El caso que rompió en real: un vault de Obsidian con 54 notas. De uno en
   * uno se comía el tope de ráfaga a los veinte y difundía 54 veces.
   */
  test('un lote de 50 archivos entra entero y difunde una sola vez', () => {
    const ana = new FakeChannel('a');
    crear(ana);
    const antes = ana.count('folder_state');

    hub.handle(ana, {
      t: 'folder_put_many',
      id: 'l1',
      files: Array.from({ length: 50 }, (_, i) => ({
        path: `notas/vault/n${i}.md`,
        text: `# nota ${i}`,
      })),
    });

    assert.equal(ana.last('folder_state')?.entries.length, 50);
    assert.equal(ana.count('folder_state') - antes, 1, 'una difusión, no cincuenta');
    assert.equal(ana.last('folder_ok')?.count, 50);
  });

  test('varios lotes seguidos no agotan el tope de ráfaga', () => {
    const ana = new FakeChannel('a');
    crear(ana);

    // 250 archivos en cinco lotes: antes eran 250 escrituras y rebotaban 230.
    for (let lote = 0; lote < 5; lote++) {
      hub.handle(ana, {
        t: 'folder_put_many',
        id: `l${lote}`,
        files: Array.from({ length: 50 }, (_, i) => ({
          path: `notas/l${lote}-n${i}.md`,
          text: 'x',
        })),
      });
    }

    assert.equal(ana.last('folder_state')?.entries.length, 250);
    assert.equal(ana.last('error'), undefined, 'ningún rebote');
  });

  test('lo que no cabe se cuenta, pero no tumba el lote', () => {
    const ana = new FakeChannel('a');
    crear(ana);

    hub.handle(ana, {
      t: 'folder_put_many',
      id: 'l1',
      files: [
        { path: 'notas/cabe.md', text: 'x' },
        { path: 'notas/enorme.md', text: 'y'.repeat(9_000_000) },
        { path: 'notas/tambien.md', text: 'z' },
      ],
    });

    assert.equal(ana.last('folder_ok')?.count, 2);
    assert.ok(ana.last('folder_state')?.entries.some((e) => e.path === 'notas/tambien.md'));
  });

  test('con write: host, un lote de otro no entra', () => {
    const ana = new FakeChannel('a');
    const beto = new FakeChannel('b');
    hub.handle(ana, {
      t: 'create',
      v: PROTOCOL_VERSION,
      name: 'Equipo',
      alias: '@ana',
      quotaRemaining: 10,
      folderWrite: 'host',
    } as never);
    const code = ana.last('welcome')?.room ?? '';
    hub.handle(beto, { t: 'join', v: PROTOCOL_VERSION, room: code, alias: '@beto', quotaRemaining: 10 });

    hub.handle(beto, {
      t: 'folder_put_many',
      id: 'l1',
      files: [{ path: 'notas/mia.md', text: 'x' }],
    });

    assert.equal(beto.last('error')?.reason, 'denied_by_owner');
  });
});
