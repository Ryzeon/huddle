import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { assertUniqueTags, type Workspace } from './config.js';

/**
 * Dos repositorios con el mismo tag colisionan en el hub: comparten
 * `alias:tag`, así que el segundo expulsa al primero — y con la lógica de
 * reconexión, se expulsan en bucle. Vale más fallar al configurar.
 */
describe('assertUniqueTags', () => {
  test('acepta un solo repo sin etiqueta', () => {
    assert.doesNotThrow(() => assertUniqueTags([{ cwd: '/a' }]));
  });

  test('acepta uno sin etiqueta más otros etiquetados', () => {
    const workspaces: Workspace[] = [
      { cwd: '/a' },
      { cwd: '/b', tag: 'api' },
      { cwd: '/c', tag: 'web' },
    ];
    assert.doesNotThrow(() => assertUniqueTags(workspaces));
  });

  test('rechaza dos etiquetas iguales', () => {
    assert.throws(
      () => assertUniqueTags([{ cwd: '/a', tag: 'api' }, { cwd: '/b', tag: 'api' }]),
      /tag "api"/,
    );
  });

  test('rechaza dos repos sin etiqueta y sugiere el arreglo', () => {
    assert.throws(() => assertUniqueTags([{ cwd: '/a' }, { cwd: '/b' }]), /--tag/);
  });

  test('una lista vacía no es un conflicto', () => {
    assert.doesNotThrow(() => assertUniqueTags([]));
  });
});
