import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatEntry, formatSource, formatTime, splitMentions } from './chat-log.js';
import type { LogEntry } from './session-state.js';

function entry(partial: Partial<LogEntry> & Pick<LogEntry, 'kind'>): LogEntry {
  return { id: 'e1', at: Date.parse('2026-08-04T09:05:00'), ...partial };
}

describe('formato del chat', () => {
  it('la entrada de alguien lleva flecha y tono de señal', () => {
    const formatted = formatEntry(entry({ kind: 'joined', alias: '@ana', meta: 'core' }));
    assert.equal(formatted.glyph, '→');
    assert.equal(formatted.alias, '@ana');
    assert.equal(formatted.text, 'entró a la sala');
    assert.equal(formatted.meta, 'core');
    assert.equal(formatted.tone, 'ok');
    assert.equal(formatted.quoted, false);
  });

  it('la salida se apaga', () => {
    const formatted = formatEntry(entry({ kind: 'left', alias: '@ana' }));
    assert.equal(formatted.glyph, '←');
    assert.equal(formatted.tone, 'muted');
  });

  it('la expulsión es alerta', () => {
    const formatted = formatEntry(entry({ kind: 'kicked', alias: '@ana', text: 'te expulsaron de la sala' }));
    assert.equal(formatted.tone, 'bad');
    assert.equal(formatted.text, 'te expulsaron de la sala');
  });

  it('el cambio de anfitrión usa el acento', () => {
    const formatted = formatEntry(entry({ kind: 'host', alias: '@bruno', meta: 'heredó el mando' }));
    assert.equal(formatted.glyph, '◆');
    assert.equal(formatted.tone, 'accent');
    assert.equal(formatted.text, 'es ahora el anfitrión');
  });

  it('un mensaje humano se marca como cita para que se pinte aparte', () => {
    const formatted = formatEntry(entry({ kind: 'message', alias: '@ana', text: 'hola' }));
    assert.equal(formatted.quoted, true);
    assert.equal(formatted.text, 'hola');
  });

  it('una pregunta sin respuesta dice a quién iba', () => {
    const formatted = formatEntry(entry({ kind: 'ask', alias: '@ana', target: '@bruno' }));
    assert.equal(formatted.text, 'preguntó a @bruno');
    assert.equal(formatted.tone, 'accent');
  });

  it('una respuesta ajena solo dice que respondió, sin contenido', () => {
    const formatted = formatEntry(entry({ kind: 'answer', alias: '@bruno', target: '@ana', meta: '3.7 s' }));
    assert.equal(formatted.text, 'respondió a @ana');
    assert.equal(formatted.quoted, false, 'sin contenido no hay cita');
    assert.equal(formatted.sources, undefined);
  });

  it('una respuesta propia sí trae texto y fuentes', () => {
    const formatted = formatEntry(
      entry({
        kind: 'answer',
        alias: '@bruno',
        text: 'en el puerto 9931',
        sources: [{ file: 'src/server.ts', line: 2 }, { file: 'README.md' }],
      }),
    );
    assert.equal(formatted.quoted, true);
    assert.deepEqual(formatted.sources, ['src/server.ts:2', 'README.md']);
  });

  it('un fallo es alerta y admite motivo', () => {
    const formatted = formatEntry(entry({ kind: 'failed', alias: '@ana', target: '@bruno', meta: 'timeout' }));
    assert.equal(formatted.tone, 'bad');
    assert.equal(formatted.glyph, '!');
  });

  it('el sistema no lleva alias', () => {
    const formatted = formatEntry(entry({ kind: 'system', text: 'la sala se cerró' }));
    assert.equal(formatted.alias, undefined);
    assert.equal(formatted.glyph, '·');
  });

  it('la hora se muestra a dos dígitos', () => {
    assert.equal(formatTime(Date.parse('2026-08-04T09:05:00')), '09:05');
    assert.equal(formatTime(Date.parse('2026-08-04T18:42:00')), '18:42');
  });

  it('las fuentes con línea llevan dos puntos', () => {
    assert.equal(formatSource({ file: 'a.ts', line: 9 }), 'a.ts:9');
    assert.equal(formatSource({ file: 'a.ts' }), 'a.ts');
  });
});

describe('resaltado de menciones', () => {
  it('separa las menciones del texto', () => {
    assert.deepEqual(splitMentions('oye @ana mira esto'), [
      { kind: 'text', value: 'oye ' },
      { kind: 'mention', value: '@ana' },
      { kind: 'text', value: ' mira esto' },
    ]);
  });

  it('reconoce el tag de repositorio', () => {
    assert.deepEqual(splitMentions('@ana:facturacion ?'), [
      { kind: 'mention', value: '@ana:facturacion' },
      { kind: 'text', value: ' ?' },
    ]);
  });

  it('un texto sin menciones sale entero', () => {
    assert.deepEqual(splitMentions('nada que ver'), [{ kind: 'text', value: 'nada que ver' }]);
  });

  it('el texto vacío no da fragmentos', () => {
    assert.deepEqual(splitMentions(''), []);
  });
});
