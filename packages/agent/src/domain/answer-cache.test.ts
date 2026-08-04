import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { QuestionCache, jaccard, tokenSet } from './answer-cache.js';
import { createMemoryCacheStore } from '../adapters/outbound/fs-stores.js';

describe('QuestionCache', () => {
  const entry = {
    question: '¿Dónde está el middleware de autenticación?',
    answer: 'En src/auth/middleware.ts',
    sources: [{ file: 'src/auth/middleware.ts', line: 12 }],
    confidence: 'high' as const,
    sha: 'abc123',
    branch: 'main',
  };

  test('acierta con la misma pregunta reformulada', () => {
    const cache = new QuestionCache(72, { store: createMemoryCacheStore() });
    cache.put(entry);

    const hit = cache.lookup('donde esta el middleware de autenticacion', 'abc123');
    assert.ok(hit, 'debería reconocer la pregunta sin tildes');
    assert.equal(hit.answer, 'En src/auth/middleware.ts');
  });

  test('no acierta con una pregunta distinta', () => {
    const cache = new QuestionCache(72, { store: createMemoryCacheStore() });
    cache.put(entry);
    assert.equal(cache.lookup('como se despliega a produccion', 'abc123'), null);
  });

  test('invalida cuando el repo se movió de SHA', () => {
    const cache = new QuestionCache(72, { store: createMemoryCacheStore() });
    cache.put(entry);

    assert.ok(cache.lookup(entry.question, 'abc123'));
    assert.equal(
      cache.lookup(entry.question, 'def456'),
      null,
      'servir una respuesta de otro commit es peor que no servir nada',
    );
  });

  test('expira por TTL', () => {
    let now = 1_000_000;
    const cache = new QuestionCache(1, {
      store: createMemoryCacheStore(),
      now: () => now,
    });
    cache.put(entry);
    assert.ok(cache.lookup(entry.question, 'abc123'));

    now += 2 * 60 * 60 * 1000; // dos horas, TTL de una
    assert.equal(cache.lookup(entry.question, 'abc123'), null);
  });

  test('una pregunta sin términos útiles nunca acierta', () => {
    const cache = new QuestionCache(72, { store: createMemoryCacheStore() });
    cache.put(entry);
    assert.equal(cache.lookup('y eso?', 'abc123'), null);
  });

  test('persiste en el store al guardar', () => {
    const store = createMemoryCacheStore();
    const cache = new QuestionCache(72, { store });
    cache.put(entry);
    assert.equal(store.read().length, 1);
    assert.equal(cache.size, 1);
  });
});

describe('similitud léxica', () => {
  test('jaccard es 1 para conjuntos idénticos y 0 para disjuntos', () => {
    assert.equal(jaccard(new Set(['a', 'b']), new Set(['a', 'b'])), 1);
    assert.equal(jaccard(new Set(['a']), new Set(['b'])), 0);
  });

  test('jaccard con un conjunto vacío es 0, no NaN', () => {
    assert.equal(jaccard(new Set(), new Set(['a'])), 0);
  });

  test('tokenize quita tildes, stopwords y palabras cortas', () => {
    const tokens = tokenSet('¿Dónde está el módulo de pagos?');
    assert.ok(tokens.has('donde') === false, 'donde es stopword');
    assert.ok(tokens.has('modulo'));
    assert.ok(tokens.has('pagos'));
  });
});
