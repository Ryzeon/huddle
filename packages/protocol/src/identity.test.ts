import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { identityProofText, keyTail, type IdentityProofInput } from './index.js';

const base: IdentityProofInput = {
  kind: 'join',
  room: 'BCDFG-HJKMN',
  alias: '@ana',
  tag: 'api',
  viewer: false,
  nonce: 'nonce123',
};

describe('el texto que se firma', () => {
  test('cambiar cualquier campo cambia el texto', () => {
    const variantes: IdentityProofInput[] = [
      { ...base, kind: 'create' },
      { ...base, room: 'BCDFG-HJKMP' },
      { ...base, alias: '@beto' },
      { ...base, tag: 'web' },
      { ...base, viewer: true },
      { ...base, nonce: 'otro' },
    ];

    const original = identityProofText(base);
    for (const variante of variantes) {
      assert.notEqual(identityProofText(variante), original);
    }
  });

  test('una firma de create no vale como join', () => {
    assert.notEqual(
      identityProofText({ ...base, kind: 'create' }),
      identityProofText({ ...base, kind: 'join' }),
    );
  });

  test('sin tag y con tag vacío firman lo mismo, y eso es intencional', () => {
    const sinTag = { ...base };
    delete sinTag.tag;
    assert.equal(identityProofText(sinTag), identityProofText({ ...base, tag: '' }));
  });

  test('ningún campo cuela un salto de línea', () => {
    assert.throws(() => identityProofText({ ...base, alias: '@ana\n@beto' }));
    assert.throws(() => identityProofText({ ...base, tag: 'api\nweb' }));
    assert.throws(() => identityProofText({ ...base, room: 'A\nB' }));
    assert.throws(() => identityProofText({ ...base, nonce: 'x\ny' }));
  });

  test('el texto empieza por el prefijo del protocolo', () => {
    assert.ok(identityProofText(base).startsWith('huddle-identity-v1\n'));
  });
});

describe('keyTail', () => {
  test('enseña los últimos ocho caracteres', () => {
    assert.equal(keyTail('0123456789abcdefXYZW1234'), 'XYZW1234');
  });
});
