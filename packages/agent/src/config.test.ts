import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { resolveSocketPath } from './config.js';

/**
 * Regresión: un path de socket largo hace fallar `listen()` con EINVAL, un
 * error opaco que costó un rato diagnosticar. Le pasa a cualquiera con un
 * `$HOME` profundo o un directorio temporal anidado.
 */
describe('resolveSocketPath', () => {
  test('usa el directorio de config cuando el path es corto', () => {
    assert.equal(resolveSocketPath('/home/yo/.huddle'), '/home/yo/.huddle/daemon.sock');
  });

  test('cae al temporal cuando el path se pasa del límite de sun_path', () => {
    const deep = `/private/tmp/${'anidado/'.repeat(20)}home`;
    const socket = resolveSocketPath(deep);

    assert.ok(socket.startsWith(tmpdir()), 'debería vivir en el temporal');
    assert.ok(Buffer.byteLength(socket) <= 104, 'debe caber en sun_path');
  });

  test('el fallback es estable: mismo directorio, mismo socket', () => {
    const deep = `/private/tmp/${'anidado/'.repeat(20)}home`;
    assert.equal(resolveSocketPath(deep), resolveSocketPath(deep));
  });

  test('directorios distintos no colisionan en el mismo socket', () => {
    const a = `/private/tmp/${'x/'.repeat(60)}a`;
    const b = `/private/tmp/${'x/'.repeat(60)}b`;
    assert.notEqual(resolveSocketPath(a), resolveSocketPath(b));
  });
});

/**
 * Windows no tiene sockets de dominio unix: `net.listen()` solo acepta named
 * pipes. Pasarle una ruta de archivo hace que el daemon ni arranque.
 */
describe('resolveSocketPath en Windows', () => {
  const home = 'C:\\Users\\ryzeon\\.huddle';

  test('usa un named pipe, no una ruta de archivo', () => {
    const socket = resolveSocketPath(home, 'win32');
    assert.ok(socket.startsWith('\\\\.\\pipe\\'), `no es un named pipe: ${socket}`);
    assert.ok(!socket.includes('C:\\'), 'no debe llevar ruta del sistema de archivos');
  });

  test('el nombre es estable entre reinicios', () => {
    assert.equal(resolveSocketPath(home, 'win32'), resolveSocketPath(home, 'win32'));
  });

  test('directorios distintos no colisionan', () => {
    assert.notEqual(
      resolveSocketPath('C:\\Users\\ana\\.huddle', 'win32'),
      resolveSocketPath('C:\\Users\\beto\\.huddle', 'win32'),
    );
  });

  test('no le aplica el límite de sun_path', () => {
    const profundo = `C:\\Users\\ryzeon\\${'carpeta\\'.repeat(30)}.huddle`;
    const socket = resolveSocketPath(profundo, 'win32');
    assert.ok(socket.startsWith('\\\\.\\pipe\\'));
    assert.ok(socket.length < 60, 'el pipe debe seguir siendo corto');
  });

  test('en unix se sigue usando un socket de archivo', () => {
    assert.equal(
      resolveSocketPath('/home/yo/.huddle', 'linux'),
      '/home/yo/.huddle/daemon.sock',
    );
  });
});
