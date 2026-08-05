import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PendingRequests, type PendingRequest } from './pending-requests.js';

function request(id: string, extra: Partial<PendingRequest> = {}): PendingRequest {
  return { id, alias: '@beto', key: 'abc12345', at: 1_000, ...extra };
}

describe('solicitudes de entrada pendientes', () => {
  test('la misma solicitud por tres repositorios se cuenta una vez', () => {
    const pending = new PendingRequests();

    // Tres workspaces, tres conexiones, el mismo aviso.
    pending.add(request('r1'));
    pending.add(request('r1'));
    pending.add(request('r1'));

    assert.equal(pending.size, 1, 'una persona esperando no son tres');
  });

  test('dos personas distintas siguen siendo dos', () => {
    const pending = new PendingRequests();
    pending.add(request('r1', { alias: '@beto' }));
    pending.add(request('r2', { alias: '@caro' }));

    assert.equal(pending.size, 2);
  });

  test('se listan por orden de llegada', () => {
    const pending = new PendingRequests();
    pending.add(request('tarde', { at: 3_000 }));
    pending.add(request('pronto', { at: 1_000 }));

    assert.deepEqual(
      pending.list().map((r) => r.id),
      ['pronto', 'tarde'],
      'el primero que llegó, el primero que se atiende',
    );
  });

  test('retirar una solicitud la quita de la lista', () => {
    const pending = new PendingRequests();
    pending.add(request('r1'));
    pending.remove('r1');

    assert.equal(pending.size, 0);
  });

  test('retirar una que no está no rompe nada', () => {
    const pending = new PendingRequests();
    assert.doesNotThrow(() => pending.remove('nunca-existió'));
  });

  test('un aviso repetido con datos nuevos se queda con los últimos', () => {
    const pending = new PendingRequests();
    pending.add(request('r1', { repo: undefined }));
    pending.add(request('r1', { repo: 'api' }));

    assert.equal(pending.list()[0]?.repo, 'api');
    assert.equal(pending.size, 1);
  });
});
