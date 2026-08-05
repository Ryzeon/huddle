import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Folder, FOLDER_LIMITS, isGenerated } from './folder.js';

const AHORA = 1_700_000_000_000;

describe('la carpeta de la sala', () => {
  test('lo que se escribe se lee', () => {
    const folder = new Folder();
    const outcome = folder.put('notas/api.md', '# API', '@ana', AHORA);

    assert.equal(outcome.kind, 'ok');
    assert.deepEqual(folder.read('notas/api.md'), {
      path: 'notas/api.md',
      text: '# API',
      by: '@ana',
      at: AHORA,
    });
  });

  test('escribir dos veces reemplaza: quien guarda último gana', () => {
    const folder = new Folder();
    folder.put('notas/api.md', 'v1', '@ana', AHORA);
    folder.put('notas/api.md', 'v2', '@beto', AHORA + 1000);

    assert.equal(folder.size, 1);
    assert.equal(folder.read('notas/api.md')?.text, 'v2');
    assert.equal(folder.read('notas/api.md')?.by, '@beto');
  });

  test('la lista va ordenada por ruta, no por orden de escritura', () => {
    const folder = new Folder();
    folder.put('z.md', 'z', '@ana', AHORA);
    folder.put('a.md', 'a', '@ana', AHORA);

    assert.deepEqual(
      folder.list().map((entry) => entry.path),
      ['a.md', 'z.md'],
    );
  });

  test('el tamaño se mide en bytes UTF-8, no en caracteres', () => {
    const folder = new Folder();
    // ñ, ñ y á ocupan dos bytes cada una; la `a`, uno.
    folder.put('notas/x.md', 'ñañá', '@ana', AHORA);
    assert.equal(folder.list()[0]?.size, 7);
  });

  test('borrar dice si había algo que borrar', () => {
    const folder = new Folder();
    folder.put('notas/x.md', 'x', '@ana', AHORA);

    assert.equal(folder.drop('notas/x.md'), true);
    assert.equal(folder.drop('notas/x.md'), false);
    assert.equal(folder.isEmpty, true);
  });
});

describe('los topes de la carpeta', () => {
  test('un archivo que no cabe ni él solo se rechaza', () => {
    const folder = new Folder();
    const outcome = folder.put(
      'notas/enorme.md',
      'x'.repeat(FOLDER_LIMITS.totalBytes + 1),
      '@ana',
      AHORA,
    );

    assert.equal(outcome.kind, 'full');
    assert.equal(folder.isEmpty, true);
  });

  test('la poda tira lo generado más antiguo para hacer sitio', () => {
    const folder = new Folder();
    for (let i = 0; i < FOLDER_LIMITS.files; i++) {
      folder.put(`respuestas/${i}.md`, 'x', '@ana', AHORA + i);
    }

    const outcome = folder.put('respuestas/nueva.md', 'x', '@ana', AHORA + 9999);

    assert.equal(outcome.kind, 'ok');
    assert.equal(folder.size, FOLDER_LIMITS.files);
    assert.equal(folder.read('respuestas/0.md'), undefined, 'la más vieja se fue');
    assert.ok(folder.read('respuestas/nueva.md'));
  });

  test('la poda no toca lo que alguien escribió a mano', () => {
    const folder = new Folder();
    folder.put('notas/decisiones.md', 'importante', '@ana', AHORA);
    for (let i = 0; i < FOLDER_LIMITS.files - 1; i++) {
      folder.put(`respuestas/${i}.md`, 'x', '@ana', AHORA + 1 + i);
    }

    folder.put('respuestas/nueva.md', 'x', '@ana', AHORA + 99999);

    assert.equal(folder.read('notas/decisiones.md')?.text, 'importante');
  });

  test('con la carpeta llena de notas a mano, se dice que no en vez de borrarlas', () => {
    const folder = new Folder();
    for (let i = 0; i < FOLDER_LIMITS.files; i++) {
      folder.put(`notas/${i}.md`, 'x', '@ana', AHORA + i);
    }

    const outcome = folder.put('notas/una-mas.md', 'x', '@ana', AHORA + 9999);

    assert.equal(outcome.kind, 'full');
    assert.equal(folder.size, FOLDER_LIMITS.files);
    assert.equal(folder.read('notas/0.md')?.text, 'x', 'no se tiró nada escrito a mano');
  });

  test('reemplazar un archivo no cuenta como uno nuevo', () => {
    const folder = new Folder();
    for (let i = 0; i < FOLDER_LIMITS.files; i++) {
      folder.put(`notas/${i}.md`, 'x', '@ana', AHORA + i);
    }

    const outcome = folder.put('notas/0.md', 'xx', '@ana', AHORA + 9999);

    assert.equal(outcome.kind, 'ok');
    assert.equal(folder.read('notas/0.md')?.text, 'xx');
  });
});

describe('qué es generado y qué no', () => {
  test('lo del hub se reconoce por su prefijo', () => {
    assert.equal(isGenerated('respuestas/2026-08-05-x.md'), true);
    assert.equal(isGenerated('temas/facturacion.md'), true);
    assert.equal(isGenerated('gente/ana.md'), true);
    assert.equal(isGenerated('notas/decisiones.md'), false);
    assert.equal(isGenerated('README.md'), false);
  });
});

describe('persistencia', () => {
  test('lo que se guarda se recupera igual', () => {
    const folder = new Folder();
    folder.put('notas/x.md', 'contenido', '@ana', AHORA);
    folder.configure('host', false);

    const otra = new Folder();
    otra.restore(folder.snapshot());

    assert.deepEqual(otra.read('notas/x.md'), folder.read('notas/x.md'));
  });

  test('un archivo de más en el disco no revienta el tope', () => {
    const folder = new Folder();
    const demasiados = Array.from({ length: FOLDER_LIMITS.files + 10 }, (_, i) => ({
      path: `respuestas/${i}.md`,
      text: 'x',
      by: '@ana',
      at: AHORA + i,
    }));

    folder.restore(demasiados);

    assert.equal(folder.size, FOLDER_LIMITS.files);
  });
});
