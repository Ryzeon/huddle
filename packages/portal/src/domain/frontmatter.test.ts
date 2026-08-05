import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { splitFrontmatter } from '../adapters/inbound/folder-view.js';

/**
 * `splitFrontmatter` vive en la vista pero no toca el DOM, así que se prueba
 * aquí como lo que es: una función de texto. Lo que sí toca el DOM —`linkify`—
 * no se prueba en Node, y por eso está separado de esto.
 */
describe('el frontmatter de una nota', () => {
  it('separa los metadatos del cuerpo', () => {
    const { meta, body } = splitFrontmatter(
      '---\nsala: ABC\nde: "@ana"\n---\n\n# Título\n\ncuerpo\n',
    );

    assert.deepEqual(meta, [
      ['sala', 'ABC'],
      ['de', '@ana'],
    ]);
    assert.equal(body, '# Título\n\ncuerpo\n');
  });

  it('una nota sin frontmatter se queda como está', () => {
    const source = '# Solo cuerpo\n\nnada más';
    assert.deepEqual(splitFrontmatter(source), { meta: [], body: source });
  });

  it('unos guiones a mitad de texto no son frontmatter', () => {
    const source = 'texto\n---\nclave: valor\n---\n';
    assert.deepEqual(splitFrontmatter(source).meta, []);
  });

  it('un frontmatter sin cerrar no se traga la nota entera', () => {
    const source = '---\nsala: ABC\n\n# Título';
    assert.equal(splitFrontmatter(source).body, source);
  });

  it('una línea sin dos puntos se ignora en vez de romper', () => {
    const { meta } = splitFrontmatter('---\nsuelta\nsala: ABC\n---\ncuerpo');
    assert.deepEqual(meta, [['sala', 'ABC']]);
  });
});
