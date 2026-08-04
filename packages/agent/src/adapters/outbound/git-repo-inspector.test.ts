/**
 * Los términos de la tarjeta deciden a quién le llega una pregunta con
 * `@auto`, así que lo que se saque de un manifiesto importa tanto como lo que
 * no. Estos tests fijan la diferencia.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { manifestTerms, describeLines } from './git-repo-inspector.js';

describe('términos de package.json', () => {
  const paquete = JSON.stringify({
    name: 'alkila-facturador',
    private: true,
    version: '1.0.0',
    description: 'Emisión de comprobantes electrónicos',
    keywords: ['facturacion', 'sunat'],
    scripts: {
      dev: 'vite --watch --out-dir dist',
      build: 'node scripts/sync-skins.js',
    },
    dependencies: { express: '^4.0.0', 'chart.js': '^3.0.0' },
    devDependencies: { eslint: '^8.0.0', prettier: '^3.0.0' },
  });

  const terms = manifestTerms('package.json', paquete);

  test('coge lo que identifica al proyecto', () => {
    assert.ok(terms.includes('alkila-facturador'));
    assert.ok(terms.includes('comprobantes'));
    assert.ok(terms.includes('facturacion'));
  });

  test('no coge los nombres de los campos', () => {
    for (const campo of ['name', 'version', 'scripts', 'private', 'description']) {
      assert.ok(!terms.includes(campo), `${campo} es un campo, no un término`);
    }
  });

  test('no coge el contenido de los scripts, que fue el bug', () => {
    // Antes se partía el archivo entero en palabras y la tarjeta acababa
    // siendo `--watch`, `node_modules`, `vite`… cuarenta términos que no
    // distinguen un repositorio de ningún otro.
    for (const ruido of ['--watch', '--out-dir', 'vite', 'sync-skins']) {
      assert.ok(!terms.includes(ruido), `no debería estar ${ruido}`);
    }
  });

  test('coge las dependencias de producción', () => {
    assert.ok(terms.includes('express'));
  });

  test('no coge las de desarrollo: son herramientas, no dominio', () => {
    assert.ok(!terms.includes('eslint'));
    assert.ok(!terms.includes('prettier'));
  });

  test('la identidad va antes que las dependencias', () => {
    assert.ok(
      terms.indexOf('alkila-facturador') < terms.indexOf('express'),
      'si algo se cae por el tope, que sea una dependencia',
    );
  });

  test('descarta versiones y palabras de plantilla', () => {
    const laravel = JSON.stringify({ name: 'laravel/laravel', description: 'The Laravel Framework.' });
    const salida = manifestTerms('composer.json', laravel);
    assert.ok(!salida.includes('the'));
    assert.ok(!salida.includes('framework'));
    assert.ok(salida.includes('laravel'), 'el nombre sí queda');
  });

  test('un JSON roto no revienta el arranque', () => {
    assert.deepEqual(manifestTerms('package.json', '{ esto no es json'), []);
  });
});

describe('términos de otros manifiestos', () => {
  test('pom.xml: artefactos, nombre y descripción', () => {
    const pom = `<project>
      <artifactId>bo-back-ms-order-management</artifactId>
      <description>Gestión de pedidos</description>
      <dependencies><dependency><artifactId>spring-boot-starter-web</artifactId></dependency></dependencies>
    </project>`;

    const terms = manifestTerms('pom.xml', pom);

    assert.ok(terms.includes('bo-back-ms-order-management'));
    assert.ok(terms.includes('pedidos'));
    assert.ok(terms.includes('spring-boot-starter-web'));
  });

  test('go.mod: el módulo se queda en su último tramo', () => {
    const terms = manifestTerms('go.mod', 'module github.com/dinet/order-service\n');
    assert.ok(terms.includes('order-service'), 'nadie pregunta por «github»');
    assert.ok(!terms.includes('github'));
  });

  test('Cargo.toml: nombre y descripción', () => {
    const terms = manifestTerms('Cargo.toml', 'name = "facturador"\ndescription = "Comprobantes"\n');
    assert.ok(terms.includes('facturador'));
    assert.ok(terms.includes('comprobantes'));
  });

  test('un manifiesto desconocido no aporta nada, y no falla', () => {
    assert.deepEqual(manifestTerms('Makefile', 'all:\n\tgo build'), []);
  });
});

describe('resumen del README', () => {
  test('los bloques de código no se indexan', () => {
    // El README de huddle trae de ejemplo una pregunta sobre facturación, y al
    // indexarla su tarjeta le ganaba al repositorio que sí trata de eso.
    const readme = [
      'Servicio de pedidos.',
      '',
      '```bash',
      'huddle ask @ryzeon "¿en qué puerto corre el servicio de facturación?"',
      '```',
      '',
      'Corre sobre Kafka.',
    ].join('\n');

    const lines = describeLines(readme).join(' ');

    assert.ok(lines.includes('pedidos'));
    assert.ok(lines.includes('Kafka'));
    assert.ok(!lines.includes('facturación'), 'eso era un ejemplo, no el dominio');
  });
});
