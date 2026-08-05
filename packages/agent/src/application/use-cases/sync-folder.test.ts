import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { FolderEntry } from '@huddle/protocol';
import { SyncFolderUseCase } from './sync-folder.js';
import type { FolderCachePort, LocalFolderEntry, RoomGatewayPort } from '../ports/index.js';

/**
 * Modela lo mismo que el adaptador de verdad: el disco por un lado y el índice
 * de lo que mandó el hub por otro. Fundirlos en un solo mapa haría imposible
 * probar lo único que importa aquí — qué pasa cuando los dos no coinciden.
 */
class CacheFalso implements FolderCachePort {
  readonly dir = '/tmp/carpeta';
  readonly disco = new Map<string, string>();
  readonly indice = new Map<string, { at: number; bajado: string }>();
  readonly apartados: string[] = [];

  list(): LocalFolderEntry[] {
    return [...this.indice].map(([path, { at, bajado }]) => ({
      path,
      syncedAt: at,
      dirty: this.disco.get(path) !== bajado,
    }));
  }

  read(path: string): string | undefined {
    return this.disco.get(path);
  }

  save(path: string, text: string, at: number): void {
    this.disco.set(path, text);
    this.indice.set(path, { at, bajado: text });
  }

  remove(path: string): void {
    this.disco.delete(path);
    this.indice.delete(path);
  }

  keepAside(path: string): string | undefined {
    const existe = this.disco.delete(path);
    this.indice.delete(path);
    if (!existe) return undefined;
    this.apartados.push(path);
    return `${path}.local`;
  }

  /** Editar es tocar el disco y solo el disco. */
  edit(path: string, text: string): void {
    this.disco.set(path, text);
  }

  borrarEnDisco(path: string): void {
    this.disco.delete(path);
  }
}

class GatewayFalso {
  readonly subidos: { path: string; text: string }[] = [];
  readonly borrados: string[] = [];
  remoto = new Map<string, string>();
  fallaAl?: string;

  fetchFile(path: string): Promise<string> {
    if (this.fallaAl === path) return Promise.reject(new Error('sin conexión'));
    return Promise.resolve(this.remoto.get(path) ?? '');
  }

  putFile(path: string, text: string): Promise<void> {
    this.subidos.push({ path, text });
    return Promise.resolve();
  }

  dropFile(path: string): Promise<void> {
    this.borrados.push(path);
    return Promise.resolve();
  }
}

const entry = (path: string, at: number): FolderEntry => ({ path, size: 1, by: '@ana', at });

describe('sincronizar la carpeta', () => {
  let cache: CacheFalso;
  let gateway: GatewayFalso;
  let avisos: string[];
  let sync: SyncFolderUseCase;

  beforeEach(() => {
    cache = new CacheFalso();
    gateway = new GatewayFalso();
    avisos = [];
    sync = new SyncFolderUseCase({
      cache,
      gateway: gateway as unknown as RoomGatewayPort,
      logger: { info: () => undefined, warn: (message) => avisos.push(message) },
    });
  });

  test('lo que no está se baja', async () => {
    gateway.remoto.set('notas/api.md', '# API');

    await sync.apply([entry('notas/api.md', 10)]);

    assert.equal(cache.read('notas/api.md'), '# API');
  });

  test('lo que ya está al día no se vuelve a bajar', async () => {
    cache.save('notas/api.md', '# API', 10);
    gateway.remoto.set('notas/api.md', 'no debería llegar');

    await sync.apply([entry('notas/api.md', 10)]);

    assert.equal(cache.read('notas/api.md'), '# API');
  });

  test('lo que cambió en la sala se vuelve a bajar', async () => {
    cache.save('notas/api.md', 'viejo', 10);
    gateway.remoto.set('notas/api.md', 'nuevo');

    await sync.apply([entry('notas/api.md', 20)]);

    assert.equal(cache.read('notas/api.md'), 'nuevo');
  });

  test('lo que desapareció de la sala se borra', async () => {
    cache.save('respuestas/vieja.md', 'x', 10);

    await sync.apply([]);

    assert.equal(cache.read('respuestas/vieja.md'), undefined);
  });

  test('un archivo que no se pudo bajar no corta la sincronización', async () => {
    gateway.remoto.set('notas/b.md', 'B');
    gateway.fallaAl = 'notas/a.md';

    await sync.apply([entry('notas/a.md', 10), entry('notas/b.md', 10)]);

    assert.equal(cache.read('notas/b.md'), 'B');
    assert.match(avisos.join('\n'), /no se pudo bajar notas\/a\.md/);
  });
});

describe('lo que se edita a mano', () => {
  let cache: CacheFalso;
  let gateway: GatewayFalso;
  let avisos: string[];
  let sync: SyncFolderUseCase;

  beforeEach(() => {
    cache = new CacheFalso();
    gateway = new GatewayFalso();
    avisos = [];
    sync = new SyncFolderUseCase({
      cache,
      gateway: gateway as unknown as RoomGatewayPort,
      logger: { info: () => undefined, warn: (message) => avisos.push(message) },
    });
  });

  test('una edición local sube en la siguiente sincronización', async () => {
    cache.save('notas/api.md', 'v1', 10);
    cache.edit('notas/api.md', 'v2 mía');

    await sync.apply([entry('notas/api.md', 10)]);

    assert.deepEqual(gateway.subidos, [{ path: 'notas/api.md', text: 'v2 mía' }]);
  });

  test('si además cambió en la sala, gana la sala pero no se pierde lo mío', async () => {
    cache.save('notas/api.md', 'v1', 10);
    cache.edit('notas/api.md', 'v2 mía');
    gateway.remoto.set('notas/api.md', 'v2 de otro');

    await sync.apply([entry('notas/api.md', 20)]);

    assert.equal(cache.read('notas/api.md'), 'v2 de otro');
    assert.deepEqual(cache.apartados, ['notas/api.md']);
    assert.match(avisos.join('\n'), /tu versión está en/);
  });

  test('lo que borraron en la sala pero yo estaba editando se aparta, no se tira', async () => {
    cache.save('notas/api.md', 'v1', 10);
    cache.edit('notas/api.md', 'lo que acabo de escribir');

    await sync.apply([]);

    assert.deepEqual(cache.apartados, ['notas/api.md']);
  });

  test('lo que genera el hub no se sube aunque se toque', async () => {
    cache.save('respuestas/x.md', 'generado', 10);
    cache.edit('respuestas/x.md', 'lo he tocado');

    await sync.apply([entry('respuestas/x.md', 10)]);

    assert.deepEqual(gateway.subidos, [], 'subirlo sería pelearse con el hub');
  });

  test('una nota nueva a mano cuenta como editada, aunque no esté en el índice', () => {
    cache.edit('notas/nueva.md', 'recién escrita');

    assert.deepEqual(sync.localState('notas/nueva.md'), { dirty: true, missing: false });
  });

  test('un archivo del índice que ya no está en el disco se ve como borrado', () => {
    cache.save('notas/api.md', 'v1', 10);
    cache.borrarEnDisco('notas/api.md');

    assert.deepEqual(sync.localState('notas/api.md'), { dirty: true, missing: true });
  });

  test('un temporal del editor que ya no está no es nada', () => {
    assert.equal(sync.localState('notas/.api.md.swp'), undefined);
  });

  test('borrar una nota en el disco la borra en la sala', async () => {
    await sync.uploadRemoval('notas/api.md');
    assert.deepEqual(gateway.borrados, ['notas/api.md']);
  });

  test('borrar algo generado no borra nada en la sala', async () => {
    await sync.uploadRemoval('respuestas/x.md');
    assert.deepEqual(gateway.borrados, []);
  });
});
