import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_TERMS,
  mergeVocabulary,
  normalizeTerm,
  parseTerms,
  vocabularyKey,
} from './vocabulary.js';

describe('normalización de términos', () => {
  test('baja a minúsculas y quita acentos, como hace el hub al tokenizar', () => {
    assert.equal(normalizeTerm('Facturación'), 'facturacion');
    assert.equal(normalizeTerm('IMPUESTOS'), 'impuestos');
  });

  test('un término con acento y su versión sin él son el mismo', () => {
    assert.equal(normalizeTerm('gestión'), normalizeTerm('gestion'));
  });

  test('la puntuación no crea términos distintos', () => {
    assert.equal(normalizeTerm('«billing»,'), 'billing');
    assert.equal(normalizeTerm('  orders.  '), 'orders');
  });

  test('conserva guiones y espacios internos: son nombres reales de repo', () => {
    assert.equal(normalizeTerm('ms-order-management'), 'ms-order-management');
    assert.equal(normalizeTerm('order   management'), 'order management');
  });
});

describe('mezcla de vocabulario', () => {
  test('lo que sabe el repositorio va primero', () => {
    const merged = mergeVocabulary(['orders', 'kafka'], ['pedidos', 'facturacion']);
    assert.deepEqual(merged.slice(0, 2), ['orders', 'kafka']);
  });

  test('no repite, aunque venga con otra forma', () => {
    const merged = mergeVocabulary(['facturacion'], ['Facturación', 'facturacion']);
    assert.deepEqual(merged, ['facturacion']);
  });

  test('descarta lo que no distingue nada', () => {
    const merged = mergeVocabulary([], ['a', 'de', 'api', 'x']);
    assert.deepEqual(merged, ['de', 'api'], 'sobran las de una sola letra');
  });

  test('descarta frases largas: un término no es una explicación', () => {
    const frase = 'este repositorio se encarga de calcular los impuestos de las facturas';
    assert.deepEqual(mergeVocabulary([], [frase]), []);
  });

  test('al topar, se recorta la conjetura y no lo que sabe el repositorio', () => {
    const base = Array.from({ length: 10 }, (_, i) => `propio${i}`);
    const extra = Array.from({ length: 200 }, (_, i) => `ampliado${i}`);

    const merged = mergeVocabulary(base, extra);

    assert.equal(merged.length, MAX_TERMS);
    for (const term of base) {
      assert.ok(merged.includes(term), `debería seguir estando ${term}`);
    }
  });
});

describe('lectura de la respuesta del motor', () => {
  test('acepta la lista directa', () => {
    assert.deepEqual(parseTerms(['orders', 'pedidos']), ['orders', 'pedidos']);
  });

  test('acepta el objeto con `terms`, que es lo que da el esquema', () => {
    assert.deepEqual(parseTerms({ terms: ['orders'] }), ['orders']);
  });

  test('acepta JSON en texto, que es como llega en `result`', () => {
    assert.deepEqual(parseTerms('{"terms":["billing","tax"]}'), ['billing', 'tax']);
  });

  test('acepta una lista en texto plano si el esquema no se respetó', () => {
    assert.deepEqual(parseTerms('orders, billing\ntax'), ['orders', 'billing', 'tax']);
  });

  test('lo que no se entiende sale vacío, no revienta', () => {
    assert.deepEqual(parseTerms(null), []);
    assert.deepEqual(parseTerms(42), []);
    assert.deepEqual(parseTerms({ otra: 'cosa' }), []);
    assert.deepEqual(parseTerms('{roto'), ['{roto']);
  });

  test('descarta los elementos que no son texto', () => {
    assert.deepEqual(parseTerms(['orders', 7, null, 'tax']), ['orders', 'tax']);
  });
});

describe('clave de invalidación', () => {
  const base = {
    repo: 'orders',
    dirs: ['src/billing', 'src/tax'],
    summary: 'Gestión de pedidos',
    keywords: ['kafka'],
  };

  test('la misma descripción da la misma clave', () => {
    assert.equal(vocabularyKey(base), vocabularyKey({ ...base }));
  });

  test('el orden de los directorios no cuenta: git no lo garantiza', () => {
    assert.equal(
      vocabularyKey(base),
      vocabularyKey({ ...base, dirs: ['src/tax', 'src/billing'] }),
    );
  });

  test('cambiar el resumen invalida', () => {
    assert.notEqual(vocabularyKey(base), vocabularyKey({ ...base, summary: 'Otra cosa' }));
  });

  test('un commit nuevo NO invalida: el repo trata de lo mismo que ayer', () => {
    // El SHA no entra en la clave a propósito. Si entrara, cada push gastaría
    // una llamada a la suscripción para volver a deducir las mismas palabras.
    const conSha = { ...base, sha: 'a44512c' };
    const conOtroSha = { ...base, sha: '9f13bd2' };
    assert.equal(vocabularyKey(conSha), vocabularyKey(conOtroSha));
  });

  test('cambiar de directorios invalida', () => {
    assert.notEqual(
      vocabularyKey(base),
      vocabularyKey({ ...base, dirs: ['src/billing', 'src/tax', 'src/auth'] }),
    );
  });
});
