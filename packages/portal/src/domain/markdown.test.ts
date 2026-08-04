import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseInline, parseMarkdown, blockToText } from './markdown.js';

describe('bloques', () => {
  test('un párrafo suelto', () => {
    const [bloque] = parseMarkdown('el puerto es 9931');
    assert.equal(bloque?.kind, 'paragraph');
  });

  test('junta las líneas de un mismo párrafo', () => {
    const bloques = parseMarkdown('una linea\ny la siguiente');
    assert.equal(bloques.length, 1);
    assert.equal(blockToText(bloques[0]!), 'una linea y la siguiente');
  });

  test('una línea en blanco separa párrafos', () => {
    assert.equal(parseMarkdown('uno\n\ndos').length, 2);
  });

  test('bloque de código con lenguaje', () => {
    const [bloque] = parseMarkdown('```ts\nconst a = 1;\n```');
    assert.equal(bloque?.kind, 'code');
    assert.equal(bloque?.kind === 'code' ? bloque.language : '', 'ts');
    assert.equal(blockToText(bloque!), 'const a = 1;');
  });

  test('dentro del código no se interpreta nada', () => {
    const [bloque] = parseMarkdown('```\n- esto no es una lista\n**ni negrita**\n```');
    assert.equal(bloque?.kind, 'code');
    assert.equal(blockToText(bloque!), '- esto no es una lista\n**ni negrita**');
  });

  test('una valla sin cerrar llega hasta el final, no se traga el texto', () => {
    const [bloque] = parseMarkdown('```\nsin cerrar\ny mas');
    assert.equal(blockToText(bloque!), 'sin cerrar\ny mas');
  });

  test('lista con viñetas', () => {
    const [bloque] = parseMarkdown('- uno\n- dos');
    assert.equal(bloque?.kind, 'list');
    assert.equal(bloque?.kind === 'list' ? bloque.ordered : true, false);
    assert.equal(bloque?.kind === 'list' ? bloque.items.length : 0, 2);
  });

  test('lista numerada', () => {
    const [bloque] = parseMarkdown('1. uno\n2. dos');
    assert.equal(bloque?.kind === 'list' ? bloque.ordered : false, true);
  });

  test('cita y título', () => {
    assert.equal(parseMarkdown('> ojo con esto')[0]?.kind, 'quote');
    const titulo = parseMarkdown('## Fuentes')[0];
    assert.equal(titulo?.kind, 'heading');
    assert.equal(titulo?.kind === 'heading' ? titulo.level : 0, 2);
  });
});

describe('en línea', () => {
  test('código, negrita y cursiva', () => {
    const partes = parseInline('usa `PORT`, es **obligatorio** y *nuevo*');
    assert.deepEqual(
      partes.filter((p) => p.kind !== 'text').map((p) => [p.kind, p.value]),
      [['code', 'PORT'], ['bold', 'obligatorio'], ['italic', 'nuevo']],
    );
  });

  test('las menciones se reconocen, con etiqueta y sin ella', () => {
    const partes = parseInline('pregunta a @ana o a @beto:api');
    assert.deepEqual(
      partes.filter((p) => p.kind === 'mention').map((p) => p.value),
      ['@ana', '@beto:api'],
    );
  });

  test('conserva el texto de alrededor sin perder nada', () => {
    const texto = 'antes `x` en medio **y** despues';
    assert.equal(parseInline(texto).map((p) => p.value).join(''), 'antes x en medio y despues');
  });

  test('un asterisco suelto no rompe nada', () => {
    const partes = parseInline('2 * 3 = 6');
    assert.equal(partes.length, 1);
    assert.equal(partes[0]?.kind, 'text');
  });
});

describe('texto plano para copiar', () => {
  test('la lista se numera al copiarla', () => {
    const [bloque] = parseMarkdown('1. uno\n2. dos');
    assert.equal(blockToText(bloque!), '1. uno\n2. dos');
  });

  test('el código se copia tal cual, sin las vallas', () => {
    const [bloque] = parseMarkdown('```js\nconst a = 1;\n```');
    assert.equal(blockToText(bloque!), 'const a = 1;');
  });

  test('el formato en línea se pierde a propósito', () => {
    const [bloque] = parseMarkdown('es **muy** importante');
    assert.equal(blockToText(bloque!), 'es muy importante');
  });
});

describe('saltos de línea', () => {
  test('un salto suelto se conserva, no se junta en un renglón', () => {
    const [bloque] = parseMarkdown('primera linea\nsegunda linea');
    const saltos = bloque?.kind === 'paragraph'
      ? bloque.content.filter((p) => p.kind === 'break').length
      : 0;
    assert.equal(saltos, 1);
  });

  test('y al copiar sale como salto de verdad', () => {
    const [bloque] = parseMarkdown('uno\ndos');
    assert.equal(blockToText(bloque!), 'uno\ndos');
  });

  test('dos líneas en blanco siguen siendo dos párrafos', () => {
    assert.equal(parseMarkdown('uno\n\ndos').length, 2);
  });
});
