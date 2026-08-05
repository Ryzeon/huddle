import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { FolderEntry } from '@huddle/protocol';
import { buildTree } from '../adapters/inbound/folder-view.js';

/**
 * `buildTree` vive en la vista pero no toca el DOM: es la forma que tiene la
 * carpeta, y se prueba como lo que es.
 */
const f = (path: string): FolderEntry => ({ path, size: 10, by: '@ana', at: 1 });

/** Aplana el árbol a texto, que es la forma legible de afirmar sobre él. */
function dibujar(nodos: ReturnType<typeof buildTree>, nivel = 0): string[] {
  return nodos.flatMap((n) => [
    `${'  '.repeat(nivel)}${n.nombre}${n.entry ? '' : '/'}`,
    ...dibujar(n.hijos, nivel + 1),
  ]);
}

describe('el árbol de la carpeta', () => {
  it('anida las subcarpetas en vez de aplanarlas', () => {
    const arbol = buildTree([
      f('notas/datos/tablas.md'),
      f('notas/README.md'),
      f('notas/datos/consultas.md'),
    ]);

    assert.deepEqual(dibujar(arbol), [
      'notas/',
      '  datos/',
      '    consultas.md',
      '    tablas.md',
      '  README.md',
    ]);
  });

  it('las carpetas van antes que los archivos', () => {
    const arbol = buildTree([f('a.md'), f('zeta/x.md'), f('b.md')]);

    assert.deepEqual(dibujar(arbol), ['zeta/', '  x.md', 'a.md', 'b.md']);
  });

  it('un archivo en la raíz no se pierde entre las carpetas', () => {
    const arbol = buildTree([f('notas/x.md'), f('README.md')]);

    assert.equal(dibujar(arbol).at(-1), 'README.md');
  });

  it('una carpeta y un archivo con el mismo nombre no se fusionan', () => {
    const arbol = buildTree([f('notas/api'), f('notas/api/v2.md')]);
    const notas = arbol[0]!;

    assert.equal(notas.hijos.length, 2);
    assert.equal(notas.hijos.filter((n) => n.entry).length, 1);
  });

  it('una carpeta vacía no existe: solo hay ramas con hojas', () => {
    assert.deepEqual(buildTree([]), []);
  });
});
