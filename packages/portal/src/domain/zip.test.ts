import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readZip, ZIP_LIMITS } from './zip.js';

/**
 * Los zips de estos tests se construyen a mano, byte a byte, en vez de leerse
 * de un fixture. Es la única forma de probar los casos que importan —un
 * método desconocido, un tamaño mentido, una entrada de carpeta— porque
 * ninguna herramienta te deja generarlos a propósito.
 */

interface Fichero {
  name: string;
  content: string;
  /** 0 guardado, 8 deflate. */
  method?: number;
  /** Para mentir en el índice: lo que el zip *dice* que ocupa al inflarse. */
  fakeSize?: number;
}

async function comprimir(text: string, method: number): Promise<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  if (method === 0) return bytes;

  const stream = new Blob([bytes.slice().buffer])
    .stream()
    .pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function makeZip(files: Fichero[]): Promise<ArrayBuffer> {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const file of files) {
    const method = file.method ?? 8;
    const name = new TextEncoder().encode(file.name);
    const raw = new TextEncoder().encode(file.content);
    const data = await comprimir(file.content, method);

    const local = new Uint8Array(30 + name.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(8, method, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(data, 30 + name.length);
    locals.push(local);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(10, method, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, file.fakeSize ?? raw.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    centrals.push(central);

    offset += local.length;
  }

  const centralSize = centrals.reduce((sum, c) => sum + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const total = [...locals, ...centrals, eocd];
  const out = new Uint8Array(total.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of total) {
    out.set(part, at);
    at += part.length;
  }
  return out.buffer;
}

describe('leer un zip', () => {
  it('saca un archivo comprimido con deflate', async () => {
    const zip = await makeZip([{ name: 'notas.md', content: '# Hola\n\nqué tal' }]);
    const { entries } = await readZip(zip);

    assert.deepEqual(entries, [{ name: 'notas.md', text: '# Hola\n\nqué tal' }]);
  });

  it('saca también los guardados sin comprimir', async () => {
    const zip = await makeZip([{ name: 'plano.txt', content: 'sin comprimir', method: 0 }]);
    const { entries } = await readZip(zip);

    assert.equal(entries[0]?.text, 'sin comprimir');
  });

  it('conserva la estructura de dentro', async () => {
    const zip = await makeZip([
      { name: 'docs/api.md', content: '# API' },
      { name: 'docs/adr/001.md', content: '# ADR' },
    ]);
    const { entries } = await readZip(zip);

    assert.deepEqual(
      entries.map((e) => e.name),
      ['docs/api.md', 'docs/adr/001.md'],
    );
  });

  it('las entradas de carpeta no son archivos', async () => {
    const zip = await makeZip([
      { name: 'docs/', content: '', method: 0 },
      { name: 'docs/api.md', content: '# API' },
    ]);
    const { entries } = await readZip(zip);

    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.name, 'docs/api.md');
  });

  it('un método que no se sabe leer se dice, no se traga', async () => {
    const zip = await makeZip([{ name: 'raro.md', content: 'x', method: 0 }]);
    // Se cambia el método a 12 (bzip2) en las dos cabeceras.
    const view = new DataView(zip);
    view.setUint16(8, 12, true);
    for (let at = 0; at < zip.byteLength - 4; at++) {
      if (view.getUint32(at, true) === 0x02014b50) view.setUint16(at + 10, 12, true);
    }

    const { entries, rechazados } = await readZip(zip);
    assert.equal(entries.length, 0);
    assert.match(rechazados[0] ?? '', /compresión/);
  });

  it('algo que no es un zip lo dice en vez de devolver vacío', async () => {
    const basura = new TextEncoder().encode('esto no es un zip, es un texto');
    await assert.rejects(() => readZip(basura.buffer), /no parece un archivo zip/);
  });

  it('un zip que se infla en algo enorme se corta antes de descomprimir', async () => {
    // 2 KB de archivo que dicen ocupar 9 MB al abrirse.
    const zip = await makeZip([
      { name: 'bomba.md', content: 'x'.repeat(100), fakeSize: 9_000_000 },
      { name: 'sano.md', content: 'no se llega a leer' },
    ]);

    const { entries, rechazados } = await readZip(zip);

    assert.equal(entries.length, 0);
    assert.match(rechazados.join(' '), /8 MB/);
  });

  it('no lee más entradas que el tope, aunque el índice diga más', async () => {
    const muchos = Array.from({ length: ZIP_LIMITS.entries + 20 }, (_, i) => ({
      name: `n${i}.md`,
      content: 'x',
    }));
    const { entries } = await readZip(await makeZip(muchos));

    assert.equal(entries.length, ZIP_LIMITS.entries);
  });
});
