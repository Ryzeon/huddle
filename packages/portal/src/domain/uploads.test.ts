import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { safeName, safePath } from './uploads.js';

describe('el nombre de un archivo que se sube', () => {
  it('quita acentos, espacios y paréntesis', () => {
    assert.equal(safeName('Notas de la Reunión (final).md'), 'Notas-de-la-Reunion-final.md');
  });

  it('no deja guiones colgando antes de la extensión ni al final', () => {
    assert.equal(safeName('informe (v2) .txt'), 'informe-v2.txt');
    assert.equal(safeName('borrador--'), 'borrador');
  });

  it('un nombre oculto deja de serlo', () => {
    assert.equal(safeName('.env'), 'env');
  });

  it('un nombre imposible no se queda vacío', () => {
    assert.equal(safeName('¿¿¿'), 'archivo.md');
  });
});

describe('la ruta de algo que viene dentro de un zip', () => {
  it('mantiene las carpetas y las sanea', async () => {
    assert.equal(safePath('docs/API de pagos.md'), 'docs/API-de-pagos.md');
  });

  it('no deja salir de la carpeta', () => {
    assert.equal(safePath('../../.ssh/id_rsa'), 'ssh/id_rsa');
    assert.equal(safePath('/etc/passwd'), 'etc/passwd');
  });

  it('tira la basura que meten los zips de macOS', () => {
    assert.equal(safePath('__MACOSX/._api.md'), null);
    assert.equal(safePath('docs/._notas.md'), null);
  });

  it('lo que viene demasiado hondo se aplana en vez de perderse', () => {
    assert.equal(safePath('a/b/c/d/e/f/g.md'), 'g.md');
  });

  it('una ruta que se queda sin nada no entra', () => {
    assert.equal(safePath('///'), null);
  });
});
