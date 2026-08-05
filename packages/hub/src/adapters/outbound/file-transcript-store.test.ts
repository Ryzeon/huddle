import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileTranscriptStore } from './file-transcript-store.js';
import type { TranscriptEntry } from '../../domain/room.js';

function entry(question: string, at = 1_000): TranscriptEntry {
  return {
    id: `q-${at}`,
    from: '@ana',
    to: '@beto',
    question,
    answer: 'la respuesta',
    sources: [],
    confidence: 'high',
    elapsedMs: 10,
    cached: false,
    at,
  };
}

describe('mover el historial de una sala', () => {
  let dir: string;
  let store: FileTranscriptStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'huddle-transcript-'));
    store = new FileTranscriptStore(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('el historial viaja con el código nuevo', () => {
    store.append('VIEJO-CODIG', 'Equipo', entry('¿dónde está el login?'));

    assert.equal(store.rename('VIEJO-CODIG', 'NUEVO-CODIG'), true);

    assert.equal(store.read('VIEJO-CODIG').length, 0, 'el código viejo ya no sirve');
    assert.equal(store.read('NUEVO-CODIG')[0]?.question, '¿dónde está el login?');
  });

  test('no pisa el historial de una sala que ya existe', () => {
    store.append('SALA-A', 'A', entry('pregunta de A'));
    store.append('SALA-B', 'B', entry('pregunta de B'));

    assert.equal(store.rename('SALA-A', 'SALA-B'), false);

    assert.equal(store.read('SALA-A')[0]?.question, 'pregunta de A', 'el origen sigue intacto');
    assert.equal(store.read('SALA-B')[0]?.question, 'pregunta de B', 'el destino sigue intacto');
  });

  test('una sala sin historial se mueve sin quejarse', () => {
    assert.equal(store.rename('SIN-NADA', 'TAMPOCO-NADA'), true);
    assert.equal(store.read('TAMPOCO-NADA').length, 0);
  });
});
