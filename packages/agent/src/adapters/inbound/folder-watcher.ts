/**
 * Vigila `notas/` en la copia local y sube lo que se edite a mano.
 *
 * Es lo que convierte la carpeta en un cuaderno común de verdad: se escribe en
 * el editor de siempre y el equipo lo ve. Solo `notas/`, porque el resto lo
 * genera el hub y volvería a bajar reescrito.
 *
 * No hay ninguna marca de «esto lo escribí yo» ni ventanas de silencio tras
 * escribir. El único criterio es si el contenido del disco difiere del último
 * que mandó el hub, que es lo que sabe el índice de la caché. Un eco no puede
 * dar la vuelta porque un archivo recién bajado nunca difiere de sí mismo.
 */

import { watch, type FSWatcher } from 'node:fs';
import { join, sep } from 'node:path';
import type { LoggerPort } from '../../application/ports/index.js';
import { EDITABLE_PREFIX, type SyncFolderUseCase } from '../../application/use-cases/sync-folder.js';

/**
 * Cuánto se espera tras un cambio antes de subirlo.
 *
 * Un editor guarda en varias escrituras —temporal, rename, ajuste de permisos—
 * y cada una dispara un evento. Sin esta espera se subiría tres veces el mismo
 * archivo, y una de ellas a medio escribir.
 */
const DEBOUNCE_MS = 400;

export interface FolderWatcherDeps {
  sync: SyncFolderUseCase;
  logger: LoggerPort;
}

export class FolderWatcher {
  private watcher?: FSWatcher;
  private readonly pending = new Map<string, NodeJS.Timeout>();

  constructor(private readonly deps: FolderWatcherDeps) {}

  start(): void {
    const dir = join(this.deps.sync.dir, EDITABLE_PREFIX.replace(/\/$/, ''));

    try {
      // `recursive` para que las subcarpetas de `notas/` cuenten. Donde no esté
      // soportado, `watch` lanza y se cae al modo sin vigilancia: la carpeta
      // sigue bajando, solo deja de subir sola.
      this.watcher = watch(dir, { recursive: true }, (_event, filename) => {
        if (filename) this.schedule(String(filename));
      });
      this.watcher.on('error', (error) => {
        this.deps.logger.warn(`se dejó de vigilar la carpeta: ${error.message}`);
      });
    } catch (error) {
      this.deps.logger.warn(
        `no se puede vigilar ${dir}, las ediciones a mano no subirán solas ` +
          `(${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }

  stop(): void {
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
    this.watcher?.close();
    this.watcher = undefined;
  }

  private schedule(filename: string): void {
    // Los archivos apartados por un conflicto son de quien los escribió, no de
    // la sala: subirlos los devolvería justo a donde no los queríamos.
    if (filename.endsWith('.local')) return;

    const path = `${EDITABLE_PREFIX}${filename.split(sep).join('/')}`;

    const previous = this.pending.get(path);
    if (previous) clearTimeout(previous);

    const timer = setTimeout(() => {
      this.pending.delete(path);
      void this.flush(path);
    }, DEBOUNCE_MS);
    timer.unref();
    this.pending.set(path, timer);
  }

  private async flush(path: string): Promise<void> {
    const local = this.deps.sync.localState(path);

    // Ni rastro en el índice ni en el disco: un temporal del editor que ya no
    // está. Subirlo crearía en la sala un archivo que aquí no existe.
    if (!local) return;

    if (local.missing) {
      await this.deps.sync.uploadRemoval(path);
      return;
    }

    if (local.dirty) await this.deps.sync.upload(path);
  }
}
