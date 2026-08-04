import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { AskQueue, type QueuedAsk } from './ask-queue.js';

describe('cola de preguntas', () => {
  let now: number;
  let cola: AskQueue;
  let corridas: string[];
  let caidas: string[];

  const ask = (id: string, ttlMs = 60_000): QueuedAsk => ({
    id,
    from: '@quien',
    deadline: now + ttlMs,
    run: async () => {
      corridas.push(id);
    },
    drop: (detalle) => caidas.push(`${id}: ${detalle}`),
  });

  beforeEach(() => {
    now = 1_000_000;
    corridas = [];
    caidas = [];
    cola = new AskQueue({ clock: { now: () => now } }, 3);
  });

  test('devuelve la posición en la fila', () => {
    assert.equal(cola.enqueue(ask('a')), 1);
    assert.equal(cola.enqueue(ask('b')), 2);
  });

  test('respeta el orden de llegada', async () => {
    cola.enqueue(ask('a'));
    cola.enqueue(ask('b'));

    cola.pump(() => true);
    await Promise.resolve();

    assert.deepEqual(corridas, ['a', 'b']);
  });

  test('solo arranca las que caben', async () => {
    cola.enqueue(ask('a'));
    cola.enqueue(ask('b'));

    let huecos = 1;
    cola.pump(() => huecos-- > 0);
    await Promise.resolve();

    assert.deepEqual(corridas, ['a'], 'la otra sigue esperando');
    assert.equal(cola.size, 1);
  });

  test('llena, dice que no en vez de dejar esperando para siempre', () => {
    assert.equal(cola.enqueue(ask('a')), 1);
    assert.equal(cola.enqueue(ask('b')), 2);
    assert.equal(cola.enqueue(ask('c')), 3);
    assert.equal(cola.enqueue(ask('d')), null, 'el tope es tres');
  });

  test('lo que caduca esperando no se responde tarde', () => {
    cola.enqueue(ask('vieja', 5_000));
    cola.enqueue(ask('nueva', 90_000));

    now += 10_000;
    cola.pump(() => false);

    assert.deepEqual(caidas, ['vieja: caducó esperando turno']);
    assert.equal(cola.size, 1, 'la otra sigue en su sitio');
  });

  test('caducar deja hueco para quien llega después', () => {
    cola.enqueue(ask('a', 1_000));
    cola.enqueue(ask('b', 1_000));
    cola.enqueue(ask('c', 1_000));

    now += 5_000;

    assert.equal(cola.enqueue(ask('d')), 1, 'las tres viejas se fueron');
    assert.equal(caidas.length, 3);
  });

  test('una pregunta que falla no atasca la cola', async () => {
    cola.enqueue({ ...ask('rota'), run: async () => { throw new Error('reventó'); } });
    cola.enqueue(ask('siguiente'));

    cola.pump(() => true);
    await Promise.resolve();
    await Promise.resolve();

    assert.deepEqual(corridas, ['siguiente'], 'la de detrás corrió igual');
    assert.equal(cola.size, 0);
  });

  test('sin nadie esperando, no reserva huecos de más', () => {
    let intentos = 0;
    cola.pump(() => {
      intentos++;
      return true;
    });
    assert.equal(intentos, 0, 'no se pide un hueco si no hay a quién dárselo');
  });
});
