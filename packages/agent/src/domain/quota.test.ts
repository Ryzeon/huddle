import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Quota, dayKey } from './quota.js';
import { createMemoryQuotaStore } from '../adapters/outbound/fs-stores.js';

/**
 * La cuota es lo que protege al dueño de quedarse sin plan por culpa de la
 * sala. Los casos que valen: agotar el tope, el cruce de medianoche, y que
 * un acierto de caché devuelva el consumo.
 */
describe('Quota', () => {
  test('concede hasta el tope diario y luego rechaza', () => {
    const quota = new Quota(2, 5, { store: createMemoryQuotaStore() });

    const first = quota.tryAcquire();
    assert.equal(first.allowed, true);
    quota.release();

    const second = quota.tryAcquire();
    assert.equal(second.allowed, true);
    quota.release();

    const third = quota.tryAcquire();
    assert.equal(third.allowed, false);
    assert.equal(third.allowed === false && third.reason, 'daily_quota');
    assert.equal(quota.remaining, 0);
  });

  test('limita la concurrencia por separado del tope diario', () => {
    const quota = new Quota(100, 1, { store: createMemoryQuotaStore() });

    assert.equal(quota.tryAcquire().allowed, true);
    const blocked = quota.tryAcquire();
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.allowed === false && blocked.reason, 'concurrency');

    quota.release();
    assert.equal(quota.tryAcquire().allowed, true);
  });

  test('reinicia el contador al cambiar el día', () => {
    let now = new Date('2026-03-10T23:59:00');
    const quota = new Quota(1, 5, {
      store: createMemoryQuotaStore(),
      now: () => now,
    });

    assert.equal(quota.tryAcquire().allowed, true);
    quota.release();
    assert.equal(quota.tryAcquire().allowed, false);

    now = new Date('2026-03-11T00:01:00');
    assert.equal(quota.remaining, 1);
    assert.equal(quota.tryAcquire().allowed, true);
  });

  test('refund devuelve el consumo cuando la respuesta salió de caché', () => {
    const quota = new Quota(3, 5, { store: createMemoryQuotaStore() });
    quota.tryAcquire();
    quota.release();
    assert.equal(quota.remaining, 2);

    quota.refund();
    assert.equal(quota.remaining, 3);
  });

  test('refund no baja de cero', () => {
    const quota = new Quota(3, 5, { store: createMemoryQuotaStore() });
    quota.refund();
    assert.equal(quota.remaining, 3);
  });

  test('sin tope diario, remaining es null y nunca rechaza por cuota', () => {
    const quota = new Quota(null, 5, { store: createMemoryQuotaStore() });
    assert.equal(quota.remaining, null);
    for (let i = 0; i < 50; i++) {
      assert.equal(quota.tryAcquire().allowed, true);
      quota.release();
    }
  });

  test('retoma el estado persistido del mismo día', () => {
    const store = createMemoryQuotaStore({ day: dayKey(new Date()), used: 4 });
    const quota = new Quota(5, 5, { store });
    assert.equal(quota.remaining, 1);
  });
});
