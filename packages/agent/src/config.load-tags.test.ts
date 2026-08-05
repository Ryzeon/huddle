import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.HUDDLE_HOME = mkdtempSync(join(tmpdir(), 'huddle-tags-'));
const { CONFIG_PATH, DEFAULT_CONFIG, loadConfig, ensureHuddleDir } = await import('./config.js');

/**
 * El hub valida `normalizeTag(tag)` y la firma del alias incluye el tag, así
 * que un tag sin normalizar en la configuración firma un texto y el hub
 * verifica otro: la firma no vale, el join se degrada a sin firma y el alias,
 * ya atado, cierra con 4007.
 */
describe('el tag que se firma es el que el hub valida', () => {
  const write = (tag: string): void => {
    ensureHuddleDir();
    writeFileSync(
      CONFIG_PATH,
      JSON.stringify({
        ...DEFAULT_CONFIG,
        room: 'SALA1-CODIG',
        alias: '@ana',
        workspaces: [{ cwd: '/x/repo', tag }],
      }),
    );
  };

  beforeEach(() => write('api'));

  test('un tag en mayúsculas se lee normalizado', () => {
    write('API');
    assert.equal(loadConfig().workspaces[0]?.tag, 'api');
  });

  test('un tag que el hub rechazaría se dice al arrancar, no se degrada', () => {
    write('API Backend');
    assert.throws(() => loadConfig(), /etiqueta inválida/);
  });

  test('un tag ya normalizado se queda como está', () => {
    assert.equal(loadConfig().workspaces[0]?.tag, 'api');
  });
});
