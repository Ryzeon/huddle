import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { AnswerStreamExtractor, decodeJsonStringPrefix } from './answer-stream.js';

/**
 * El caso que importa: el JSON llega partido en trozos arbitrarios, y un
 * escape puede quedar cortado por la mitad entre dos chunks. Si eso emite
 * basura, el usuario ve caracteres rotos en el chat.
 */
describe('AnswerStreamExtractor', () => {
  test('extrae el texto de answer conforme llega', () => {
    const ex = new AnswerStreamExtractor();
    const out: string[] = [];
    out.push(ex.push('{"answer":"Hola'));
    out.push(ex.push(' mundo'));
    out.push(ex.push('","sources":[]}'));
    assert.equal(out.join(''), 'Hola mundo');
    assert.equal(ex.isComplete, true);
  });

  test('no emite nada hasta encontrar la clave answer', () => {
    const ex = new AnswerStreamExtractor();
    assert.equal(ex.push('{"confidence":"high",'), '');
    assert.equal(ex.push('"answer":"ya"'), 'ya');
  });

  test('aguanta un escape \\u partido entre dos chunks', () => {
    const ex = new AnswerStreamExtractor();
    // Emite lo que ya es seguro y retiene solo el escape a medias: así el
    // streaming no se frena esperando a que llegue el resto de `é`.
    assert.equal(ex.push('{"answer":"caf\\u00'), 'caf');
    assert.equal(ex.push('e9 listo"'), 'é listo');
    assert.equal(ex.text, 'café listo');
  });

  test('aguanta una barra invertida al final del chunk', () => {
    const ex = new AnswerStreamExtractor();
    assert.equal(ex.push('{"answer":"linea\\'), 'linea');
    assert.equal(ex.push('n2"'), '\n2');
  });

  test('decodifica los escapes simples', () => {
    const ex = new AnswerStreamExtractor();
    const text = ex.push('{"answer":"a\\"b\\\\c\\td"}');
    assert.equal(text, 'a"b\\c\td');
  });

  test('una comilla escapada no cierra el valor', () => {
    const ex = new AnswerStreamExtractor();
    ex.push('{"answer":"dice \\"hola\\" y sigue"}');
    assert.equal(ex.isComplete, true);
    assert.equal(ex.text, 'dice "hola" y sigue');
  });

  test('deja de emitir después de cerrar', () => {
    const ex = new AnswerStreamExtractor();
    ex.push('{"answer":"fin","sources":[]}');
    assert.equal(ex.push('mas texto'), '');
  });

  test('carácter a carácter da el mismo resultado que de una vez', () => {
    const payload = '{"answer":"multi\\nlinea con \\u00f1","sources":[]}';
    const oneShot = new AnswerStreamExtractor();
    const expected = oneShot.push(payload);

    const drip = new AnswerStreamExtractor();
    let got = '';
    for (const ch of payload) got += drip.push(ch);

    assert.equal(got, expected);
    assert.equal(got, 'multi\nlinea con ñ');
  });
});

describe('decodeJsonStringPrefix', () => {
  test('marca closed al llegar a la comilla de cierre', () => {
    assert.deepEqual(decodeJsonStringPrefix('abc"resto', 0), { text: 'abc', closed: true });
  });

  test('no marca closed si el buffer se acaba antes', () => {
    assert.deepEqual(decodeJsonStringPrefix('abc', 0), { text: 'abc', closed: false });
  });

  test('se detiene antes de un escape inválido en vez de inventar', () => {
    assert.deepEqual(decodeJsonStringPrefix('ab\\xcd', 0), { text: 'ab', closed: false });
  });
});
