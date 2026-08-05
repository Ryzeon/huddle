import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeFolderPath } from './index.js';
import { LIMITS, ValidationError, validateClientMessage } from './validate.js';

describe('la ruta de un archivo de la carpeta', () => {
  test('acepta lo que parece una nota', () => {
    assert.equal(normalizeFolderPath('notas/decisiones.md'), 'notas/decisiones.md');
    assert.equal(normalizeFolderPath('temas/facturacion.md'), 'temas/facturacion.md');
    assert.equal(normalizeFolderPath('README.md'), 'README.md');
  });

  test('normaliza los separadores de Windows', () => {
    assert.equal(normalizeFolderPath('notas\\api\\v2.md'), 'notas/api/v2.md');
  });

  test('una ruta absoluta se rechaza en vez de reinterpretarse', () => {
    assert.throws(() => normalizeFolderPath('/notas/api.md'));
  });

  test('no deja salir de la carpeta', () => {
    for (const intento of [
      '../config.json',
      'notas/../../.ssh/id_rsa',
      '..',
      'notas/..',
      '/etc/passwd',
      'C:\\Windows\\system32\\x.md',
      'notas/%2e%2e/x.md',
      'notas//x.md',
      './x.md',
    ]) {
      assert.throws(() => normalizeFolderPath(intento), `debería rechazar ${intento}`);
    }
  });

  test('un archivo oculto no entra: la carpeta se lee, no se esconde', () => {
    assert.throws(() => normalizeFolderPath('.env'));
    assert.throws(() => normalizeFolderPath('notas/.git/config'));
  });

  test('nada ejecutable, aunque nadie lo ejecute', () => {
    for (const intento of ['limpiar.sh', 'notas/deploy.ps1', 'x.EXE', 'a/b/c.bat']) {
      assert.throws(() => normalizeFolderPath(intento), `debería rechazar ${intento}`);
    }
  });

  test('hay un tope de profundidad y de longitud', () => {
    assert.throws(() => normalizeFolderPath('a/b/c/d/e/f/g.md'));
    assert.throws(() => normalizeFolderPath(`${'x'.repeat(200)}.md`));
  });

  test('la ruta vacía no es una ruta', () => {
    assert.throws(() => normalizeFolderPath(''));
    assert.throws(() => normalizeFolderPath('   '));
  });
});

describe('validación de los mensajes de carpeta', () => {
  test('folder_put pasa con lo mínimo', () => {
    const msg = validateClientMessage({
      t: 'folder_put',
      id: 'abc',
      path: 'notas/x.md',
      text: '# hola',
    });
    assert.deepEqual(msg, { t: 'folder_put', id: 'abc', path: 'notas/x.md', text: '# hola' });
  });

  test('una ruta que se escapa se rechaza en la frontera, no dentro', () => {
    assert.throws(
      () =>
        validateClientMessage({
          t: 'folder_put',
          id: 'abc',
          path: '../../.ssh/authorized_keys',
          text: 'x',
        }),
      ValidationError,
    );
  });

  test('el motivo real llega al cliente, no un «frame inválido»', () => {
    try {
      validateClientMessage({ t: 'folder_put', id: 'a', path: 'x.sh', text: 'x' });
      assert.fail('debería haber lanzado');
    } catch (error) {
      assert.ok(error instanceof ValidationError);
      assert.match(error.message, /\.sh/);
    }
  });

  test('un archivo enorme no pasa', () => {
    assert.throws(
      () =>
        validateClientMessage({
          t: 'folder_put',
          id: 'a',
          path: 'notas/x.md',
          text: 'x'.repeat(LIMITS.folderText + 1),
        }),
      ValidationError,
    );
  });

  test('folder_drop y folder_get también sanean la ruta', () => {
    assert.throws(() => validateClientMessage({ t: 'folder_drop', id: 'a', path: '../x' }));
    assert.throws(() => validateClientMessage({ t: 'folder_get', id: 'a', path: '../x' }));
  });
});

describe('la carpeta al crear la sala', () => {
  const base = { t: 'create', v: 1, name: 'Equipo', alias: '@ana', quotaRemaining: null };

  test('por defecto escribe cualquiera y la memoria está encendida', () => {
    const msg = validateClientMessage({ ...base });
    assert.equal('folderWrite' in msg, false);
    assert.equal('folderMemory' in msg, false);
  });

  test('se puede reservar la escritura al anfitrión', () => {
    const msg = validateClientMessage({ ...base, folderWrite: 'host' });
    assert.equal((msg as { folderWrite?: string }).folderWrite, 'host');
  });

  test('un valor desconocido cae en el que no sorprende a nadie', () => {
    const msg = validateClientMessage({ ...base, folderWrite: 'todos-menos-ana' });
    assert.equal('folderWrite' in msg, false);
  });

  test('la memoria se apaga solo con un false explícito', () => {
    assert.equal((validateClientMessage({ ...base, folderMemory: false }) as never)['folderMemory'], false);
    assert.equal('folderMemory' in validateClientMessage({ ...base, folderMemory: 'no' }), false);
  });
});
