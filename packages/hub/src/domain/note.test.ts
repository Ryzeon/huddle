import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeFolderPath } from '@huddle/protocol';
import { buildNote, linkInto, notePath, slugify, topicsOf, type NoteSource } from './note.js';

const base: NoteSource = {
  id: '01ABCDEFGHIJKLMNWXYZ',
  room: 'MPP8V-7HZS5',
  from: '@ana',
  to: '@ryzeon',
  question: '¿En qué puerto corre el servicio de facturación?',
  answer: 'En el 9931, por la constante BILLING_PORT.',
  sources: [{ file: 'src/server.ts', line: 2 }],
  confidence: 'high',
  sha: 'a44512c',
  at: Date.UTC(2026, 7, 5, 12, 32),
  repo: 'mi-servicio',
  keywords: ['facturacion', 'billing', 'puertos', 'http'],
};

describe('de qué trata una respuesta', () => {
  test('los temas salen de cruzar la pregunta con el vocabulario del repo', () => {
    const temas = topicsOf(base.question, base.keywords);
    assert.ok(temas.includes('facturacion'), `esperaba facturacion en ${temas.join(', ')}`);
    assert.ok(temas.includes('puerto'), `esperaba puerto en ${temas.join(', ')}`);
  });

  test('una palabra que el repo no conoce no se convierte en tema', () => {
    assert.equal(topicsOf('¿dónde está el kubernetes?', ['facturacion']).includes('facturacion'), false);
  });

  test('sin vocabulario, la nota no se queda huérfana', () => {
    const temas = topicsOf('¿cómo se autentican los webhooks?', []);
    assert.ok(temas.length > 0);
    assert.ok(temas.includes('webhook'));
  });

  test('no repite el mismo tema por decirlo dos veces', () => {
    const temas = topicsOf('facturación y más facturación', ['facturacion']);
    assert.deepEqual(temas, ['facturacion']);
  });
});

describe('la ruta de una nota', () => {
  test('lleva fecha, quién respondió y de qué iba', () => {
    const path = notePath(base);

    assert.ok(path.startsWith('respuestas/2026-08-05-ryzeon-en-que-puerto-corre-el-'));
    assert.ok(path.endsWith('-wxyz.md'), path);
    // La cadena exacta no se afirma: depende de dónde caiga el recorte, y lo
    // que de verdad importa es que la ruta valga. La versión anterior de este
    // test fijaba un nombre de 73 caracteres que el propio hub rechazaba
    // después al pedirlo.
    assert.doesNotThrow(() => normalizeFolderPath(path));
  });

  test('la misma pregunta dos veces el mismo día no se pisa', () => {
    const otra = { ...base, id: '01ZZZZZZZZZZZZZZ0000' };
    assert.notEqual(notePath(base), notePath(otra));
  });

  test('una pregunta sin nada alfanumérico sigue teniendo ruta', () => {
    assert.equal(slugify('¿¿¿???'), 'nota');
  });
});

describe('la nota', () => {
  test('trae el frontmatter con quién, dónde y con qué confianza', () => {
    const { text } = buildNote(base);
    assert.match(text, /^---\n/);
    assert.match(text, /sala: MPP8V-7HZS5/);
    assert.match(text, /de: "@ana"/);
    assert.match(text, /a: "@ryzeon"/);
    assert.match(text, /repo: mi-servicio · a44512c/);
    assert.match(text, /confianza: high/);
    assert.match(text, /at: 2026-08-05T12:32:00.000Z/);
  });

  test('cita las fuentes con archivo y línea', () => {
    assert.match(buildNote(base).text, /\*\*Fuentes:\*\* `src\/server\.ts:2`/);
  });

  test('enlaza a las dos personas y a los temas', () => {
    const { text, links } = buildNote(base);
    assert.match(text, /\[\[gente\/ana\]\]/);
    assert.match(text, /\[\[gente\/ryzeon\]\]/);
    assert.match(text, /\[\[temas\/facturacion\]\]/);

    // Los enlaces que hay que crear son solo los del que responde: la nota
    // enlaza a quien preguntó, pero su nodo lista lo que *contesta*.
    assert.ok(links.includes('gente/ryzeon.md'));
    assert.ok(links.includes('temas/facturacion.md'));
  });

  test('una respuesta sin fuentes no inventa una línea de fuentes', () => {
    assert.equal(buildNote({ ...base, sources: [] }).text.includes('**Fuentes:**'), false);
  });
});

describe('los nodos del grafo', () => {
  test('el primero crea el nodo con su cabecera', () => {
    const texto = linkInto(undefined, 'respuestas/x.md', 'temas/facturacion.md');
    assert.equal(
      texto,
      '# facturacion\n\nLo que se ha preguntado sobre esto en la sala.\n- [[respuestas/x]]\n',
    );
  });

  test('el segundo se añade sin tocar lo anterior', () => {
    const primero = linkInto(undefined, 'respuestas/a.md', 'temas/x.md')!;
    const segundo = linkInto(primero, 'respuestas/b.md', 'temas/x.md')!;

    assert.ok(segundo.includes('- [[respuestas/a]]'));
    assert.ok(segundo.includes('- [[respuestas/b]]'));
  });

  test('un enlace repetido no reescribe el nodo', () => {
    const primero = linkInto(undefined, 'respuestas/a.md', 'temas/x.md')!;
    assert.equal(linkInto(primero, 'respuestas/a.md', 'temas/x.md'), null);
  });

  test('el nodo de una persona dice lo que ha respondido', () => {
    const texto = linkInto(undefined, 'respuestas/x.md', 'gente/ryzeon.md')!;
    assert.match(texto, /^# ryzeon\n/);
    assert.match(texto, /ha respondido/);
  });
});

describe('los verbos no son temas', () => {
  test('«qué tabla guarda los cobros» no crea temas/guarda', () => {
    const temas = topicsOf('¿Qué tabla guarda los cobros?', []);
    assert.equal(temas.includes('guarda'), false, `salió ${temas.join(', ')}`);
    assert.ok(temas.includes('tabla') || temas.includes('cobro'));
  });

  test('«por qué campos se identifica una factura» tampoco', () => {
    const temas = topicsOf('¿Por qué campos se identifica una factura?', []);
    assert.equal(temas.includes('identifica'), false, `salió ${temas.join(', ')}`);
    assert.ok(temas.includes('factura') || temas.includes('campo'));
  });
});

describe('lo que el hub genera tiene que caber por su propia puerta', () => {
  /**
   * Este es el fallo que se vio en real: una pregunta larga generaba una nota
   * de 71 caracteres, y `normalizeFolderPath` corta en 64. La nota existía en
   * la carpeta pero nadie podía abrirla, y no llegaba a ningún disco.
   */
  test('una pregunta larguísima sigue dando una ruta válida', () => {
    const path = notePath({
      ...base,
      to: '@ryz',
      question: '¿Cómo se reintenta un cobro fallido y dónde queda registrado el intento?',
    });

    assert.doesNotThrow(() => normalizeFolderPath(path));
    assert.ok(path.startsWith('respuestas/2026-08-05-ryz-'));
    assert.ok(path.endsWith('.md'));
  });

  test('ni el alias más largo posible la rompe', () => {
    const path = notePath({
      ...base,
      to: `@${'x'.repeat(31)}`,
      question: 'a'.repeat(400),
    });

    assert.doesNotThrow(() => normalizeFolderPath(path));
  });

  test('las notas y los nodos que genera pasan todos la frontera', () => {
    const { path, links } = buildNote({
      ...base,
      to: '@ryz',
      question: '¿Cómo se reintenta un cobro que falló y dónde se guarda el resultado?',
      keywords: ['facturacion', 'cobros', 'reintentos'],
    });

    for (const ruta of [path, ...links]) {
      assert.doesNotThrow(() => normalizeFolderPath(ruta), `no pasa: ${ruta}`);
    }
  });
});
