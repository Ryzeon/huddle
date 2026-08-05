/**
 * La carpeta de la sala, en disco.
 *
 * Archivos de verdad en un directorio de verdad: es lo que permite que el
 * motor los lea con `--add-dir`, que `grep` los encuentre y que se abran en
 * cualquier editor de notas. Nada de esto funcionaría con un blob en un JSON.
 *
 * Junto a ellos vive un índice oculto con lo último que mandó el hub. Sirve
 * para dos cosas que no se pueden deducir del sistema de archivos: qué
 * versión tenemos de cada archivo, y si lo que hay en disco sigue siendo eso o
 * alguien lo ha editado.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, sep } from 'node:path';
import { normalizeFolderPath } from '@huddle/protocol';
import type { FolderCachePort, LocalFolderEntry } from '../../application/ports/index.js';

const INDEX_FILE = '.huddle-estado.json';

interface IndexEntry {
  at: number;
  /** Hash de lo que se escribió. Si el del disco no coincide, lo han editado. */
  hash: string;
}

function hashOf(text: string): string {
  return createHash('sha256').update(text).digest('base64url').slice(0, 22);
}

export class FsFolderCache implements FolderCachePort {
  private index: Record<string, IndexEntry> = {};

  constructor(readonly dir: string) {
    // `notas/` se crea aunque esté vacía, y no solo cuando llegue el primer
    // archivo: es donde se escribe a mano, así que tiene que existir para
    // poder vigilarla desde el arranque y para que se vea dónde escribir.
    mkdirSync(join(dir, 'notas'), { recursive: true, mode: 0o700 });
    this.index = this.readIndex();
  }

  list(): LocalFolderEntry[] {
    const out: LocalFolderEntry[] = [];

    for (const [path, entry] of Object.entries(this.index)) {
      const text = this.read(path);
      if (text === undefined) {
        // Lo borraron del disco. Se reporta como editado y sin contenido, para
        // que el vigilante decida; el caso de uso no toca el sistema de
        // archivos y no puede enterarse de otra forma.
        out.push({ path, syncedAt: entry.at, dirty: true });
        continue;
      }
      out.push({ path, syncedAt: entry.at, dirty: hashOf(text) !== entry.hash });
    }

    return out;
  }

  read(path: string): string | undefined {
    const file = this.resolve(path);
    if (!file || !existsSync(file)) return undefined;
    try {
      return readFileSync(file, 'utf8');
    } catch {
      return undefined;
    }
  }

  save(path: string, text: string, at: number): void {
    const file = this.resolve(path);
    if (!file) return;

    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(file, text, { mode: 0o600 });
      this.index[path] = { at, hash: hashOf(text) };
      this.writeIndex();
    } catch {
      // Sin la copia local el agente sigue respondiendo sobre su repositorio:
      // se pierde el contexto de la sala, no la capacidad de contestar.
    }
  }

  remove(path: string): void {
    const file = this.resolve(path);
    if (!file) return;

    try {
      rmSync(file, { force: true });
    } catch {
      /* si no se puede borrar, el índice ya no lo cuenta */
    }
    delete this.index[path];
    this.writeIndex();
  }

  /**
   * Aparta una edición local que perdió contra el hub.
   *
   * Sale del índice a propósito: el archivo apartado deja de ser una copia de
   * nada y no vuelve a sincronizarse. Es tuyo, y lo que hagas con él es cosa
   * tuya.
   */
  keepAside(path: string): string | undefined {
    const file = this.resolve(path);
    if (!file || !existsSync(file)) {
      delete this.index[path];
      this.writeIndex();
      return undefined;
    }

    const aside = `${file}.local`;
    try {
      renameSync(file, aside);
    } catch {
      return undefined;
    }

    delete this.index[path];
    this.writeIndex();
    return `${path}.local`;
  }

  /**
   * De ruta de la sala a ruta del disco.
   *
   * Vuelve a pasar por `normalizeFolderPath` aunque el hub ya lo hiciera: esta
   * es la última línea antes de escribir de verdad en el disco de alguien, y
   * es el único sitio donde un fallo se convierte en un archivo fuera de sitio.
   */
  private resolve(path: string): string | undefined {
    try {
      return join(this.dir, normalizeFolderPath(path).split('/').join(sep));
    } catch {
      return undefined;
    }
  }

  private readIndex(): Record<string, IndexEntry> {
    const file = join(this.dir, INDEX_FILE);
    if (!existsSync(file)) return {};

    try {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
      if (typeof parsed !== 'object' || parsed === null) return {};
      return parsed as Record<string, IndexEntry>;
    } catch {
      // Sin índice, todo se ve como editado y se vuelve a bajar. Se pierde
      // tiempo, no datos.
      return {};
    }
  }

  private writeIndex(): void {
    try {
      writeFileSync(join(this.dir, INDEX_FILE), `${JSON.stringify(this.index)}\n`, {
        mode: 0o600,
      });
    } catch {
      /* ver readIndex: sin índice se resincroniza de más, nada más */
    }
  }
}
