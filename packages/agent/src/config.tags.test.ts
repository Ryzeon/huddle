import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { assignTag, tagFromPath } from './config.js';

/**
 * Nadie debería tener que inventarse una etiqueta para empezar: el nombre de
 * la carpeta ya dice de qué repo se trata. Solo se pide a mano si dos repos
 * se llaman igual.
 */
describe('tagFromPath', () => {
  test('usa el nombre de la carpeta', () => {
    assert.equal(tagFromPath('/Users/ana/work/orders-api'), 'orders-api');
  });

  test('funciona con rutas de Windows', () => {
    assert.equal(tagFromPath('C:\\Users\\aavilaa\\repos\\mi-servicio'), 'mi-servicio');
  });

  test('ignora la barra final', () => {
    assert.equal(tagFromPath('/home/yo/proyecto/'), 'proyecto');
  });

  test('normaliza mayúsculas, espacios y tildes', () => {
    assert.equal(tagFromPath('/x/Facturación Backend'), 'facturacion-backend');
  });

  test('recorta nombres larguísimos', () => {
    const tag = tagFromPath(`/x/${'a'.repeat(80)}`);
    assert.ok(tag.length <= 24, `demasiado largo: ${tag.length}`);
  });

  test('no deja guiones colgando al recortar', () => {
    assert.ok(!tagFromPath('/x/servicio-de-facturacion-y-cobros-2026').endsWith('-'));
  });

  test('una carpeta sin caracteres usables cae a "repo"', () => {
    assert.equal(tagFromPath('/x/___'), 'repo');
  });
});

describe('assignTag', () => {
  test('sin conflicto usa el nombre tal cual', () => {
    assert.equal(assignTag('/x/pagos', []), 'pagos');
  });

  test('ante una colisión añade sufijo en vez de fallar', () => {
    assert.equal(assignTag('/otro/pagos', ['pagos']), 'pagos-2');
  });

  test('sigue subiendo hasta encontrar uno libre', () => {
    assert.equal(assignTag('/z/pagos', ['pagos', 'pagos-2', 'pagos-3']), 'pagos-4');
  });

  test('el sufijo tampoco se pasa de largo', () => {
    const taken = [tagFromPath(`/x/${'b'.repeat(40)}`)];
    const tag = assignTag(`/y/${'b'.repeat(40)}`, taken);
    assert.ok(tag.length <= 24);
    assert.notEqual(tag, taken[0]);
  });
});
