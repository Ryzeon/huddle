import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyMention, findMentionQuery, parseDraft, rankMentions } from './composer.js';

const SALA = ['@ana', '@ana:api', '@bruno', '@carla:facturacion', '@all', '@auto'];

describe('detección de la mención en curso', () => {
  it('encuentra la mención justo donde está el cursor', () => {
    assert.deepEqual(findMentionQuery('oye @an', 7), { start: 4, end: 7, query: 'an' });
  });

  it('un @ recién tecleado ya cuenta, con consulta vacía', () => {
    assert.deepEqual(findMentionQuery('@', 1), { start: 0, end: 1, query: '' });
  });

  it('no confunde un correo con una mención', () => {
    assert.equal(findMentionQuery('escribe a dev@ryzeon', 20), null);
  });

  it('deja de contar cuando ya hay un espacio detrás', () => {
    assert.equal(findMentionQuery('@ana hola', 9), null);
  });

  it('si el cursor está antes del @, no hay mención', () => {
    assert.equal(findMentionQuery('hola @ana', 3), null);
  });

  it('acepta los dos puntos del tag', () => {
    assert.deepEqual(findMentionQuery('@ana:fa', 7), { start: 0, end: 7, query: 'ana:fa' });
  });
});

describe('ranking de candidatos', () => {
  it('los que empiezan por lo tecleado van primero', () => {
    assert.deepEqual(rankMentions('an', SALA), ['@ana', '@ana:api']);
  });

  it('también encuentra por el medio, pero después', () => {
    assert.deepEqual(rankMentions('api', SALA), ['@ana:api']);
    assert.deepEqual(rankMentions('a', SALA).slice(0, 3), ['@all', '@ana', '@ana:api']);
  });

  it('sin nada tecleado devuelve la sala entera en orden', () => {
    assert.deepEqual(rankMentions('', SALA), [
      '@all',
      '@ana',
      '@ana:api',
      '@auto',
      '@bruno',
      '@carla:facturacion',
    ]);
  });

  it('lo que no encaja no aparece', () => {
    assert.deepEqual(rankMentions('zzz', SALA), []);
  });

  it('no distingue mayúsculas', () => {
    assert.deepEqual(rankMentions('BRU', SALA), ['@bruno']);
  });
});

describe('aplicar una sugerencia', () => {
  it('sustituye lo tecleado y deja el cursor tras el espacio', () => {
    const mention = findMentionQuery('oye @an', 7);
    assert.ok(mention);
    assert.deepEqual(applyMention('oye @an', mention, '@ana'), { text: 'oye @ana ', caret: 9 });
  });

  it('respeta lo que venga detrás del cursor', () => {
    const mention = findMentionQuery('@br y ya', 3);
    assert.ok(mention);
    assert.deepEqual(applyMention('@br y ya', mention, '@bruno'), {
      text: '@bruno  y ya',
      caret: 7,
    });
  });
});

describe('qué se manda al pulsar enter', () => {
  it('lo normal es chat', () => {
    assert.deepEqual(parseDraft('  hola a todos  '), { kind: 'message', text: 'hola a todos' });
  });

  it('vacío no manda nada', () => {
    assert.deepEqual(parseDraft('   \n '), { kind: 'empty' });
  });

  it('/ask separa destino y pregunta', () => {
    assert.deepEqual(parseDraft('/ask @bruno ¿en qué puerto corre?'), {
      kind: 'ask',
      to: '@bruno',
      question: '¿en qué puerto corre?',
    });
  });

  it('/preguntar hace lo mismo', () => {
    assert.deepEqual(parseDraft('/preguntar @ana:api quién toca el rate limiter'), {
      kind: 'ask',
      to: '@ana:api',
      question: 'quién toca el rate limiter',
    });
  });

  it('@all y @auto valen como destino', () => {
    assert.deepEqual(parseDraft('/ask @all alguien sabe?'), {
      kind: 'ask',
      to: '@all',
      question: 'alguien sabe?',
    });
  });

  it('un /ask a medias explica cómo se usa', () => {
    assert.deepEqual(parseDraft('/ask @bruno'), {
      kind: 'invalid',
      reason: 'usa: /ask @alias tu pregunta',
    });
  });

  it('un comando inventado se rechaza con su nombre', () => {
    assert.deepEqual(parseDraft('/salir ya'), {
      kind: 'invalid',
      reason: 'comando desconocido: /salir',
    });
  });

  it('una pregunta multilínea conserva los saltos', () => {
    const draft = parseDraft('/ask @ana primera\nsegunda');
    assert.deepEqual(draft, { kind: 'ask', to: '@ana', question: 'primera\nsegunda' });
  });
});
