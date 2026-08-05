/**
 * Mantener la copia local de la carpeta de la sala.
 *
 * Baja lo que cambió, borra lo que desapareció y sube lo que se editó a mano.
 * El resultado es un directorio de verdad en el disco, que es lo que permite
 * que el motor lo lea con `--add-dir` y lo grepee como si fuera un repositorio
 * más — sin índice que mantener ni búsqueda que escribir.
 *
 * Quién manda cuando los dos lados cambian: el hub. Es la única regla que
 * puede sostenerse sin fusionar textos, y para que no cueste trabajo perdido,
 * la versión local se aparta en vez de borrarse.
 */

import type { FolderEntry } from '@huddle/protocol';
import type { FolderCachePort, LoggerPort, RoomGatewayPort } from '../ports/index.js';

/** Lo único que se puede editar a mano. El resto lo genera el hub. */
export const EDITABLE_PREFIX = 'notas/';

export interface SyncFolderDeps {
  cache: FolderCachePort;
  gateway: RoomGatewayPort;
  logger: LoggerPort;
}

export class SyncFolderUseCase {
  constructor(private readonly deps: SyncFolderDeps) {}

  get dir(): string {
    return this.deps.cache.dir;
  }

  /** Lo que hay en la copia local, sin ir al hub. */
  read(path: string): string | undefined {
    return this.deps.cache.read(path);
  }

  /** Aplica el estado que acaba de anunciar el hub. */
  async apply(entries: FolderEntry[]): Promise<void> {
    const { cache, gateway, logger } = this.deps;

    const local = new Map(cache.list().map((entry) => [entry.path, entry]));
    const remote = new Map(entries.map((entry) => [entry.path, entry]));

    for (const entry of entries) {
      const mine = local.get(entry.path);

      if (mine && mine.syncedAt >= entry.at) {
        // Al día con el hub. Si además está editado, es una edición nuestra que
        // todavía no ha subido: se sube en vez de tirarla.
        if (mine.dirty) await this.upload(entry.path);
        continue;
      }

      // Cambió en el hub. Si además lo teníamos editado, esa edición ha
      // perdido; se aparta para que quien la escribió pueda recuperarla.
      if (mine?.dirty) {
        const kept = cache.keepAside(entry.path);
        if (kept) {
          logger.warn(
            `${entry.path} cambió en la sala mientras lo editabas; tu versión está en ${kept}`,
          );
        }
      }

      try {
        cache.save(entry.path, await gateway.fetchFile(entry.path), entry.at);
      } catch (error) {
        // Un archivo que no se pudo bajar se reintenta en el siguiente estado:
        // cortar aquí dejaría sin sincronizar a los que van detrás.
        logger.warn(`no se pudo bajar ${entry.path}: ${describe(error)}`);
      }
    }

    for (const [path, mine] of local) {
      if (remote.has(path)) continue;

      // Lo borraron en la sala. Una edición local sin subir se aparta: puede
      // ser justo lo que alguien acaba de escribir.
      if (mine.dirty) cache.keepAside(path);
      else cache.remove(path);
    }
  }

  /**
   * Qué le pasa a un archivo en el disco. Lo consulta el vigilante.
   *
   * Un archivo que está en el disco pero no en el índice cuenta como editado:
   * es una nota nueva, que es el caso que más importa. Sin esa regla, escribir
   * un archivo nuevo a mano no lo subiría nunca.
   */
  localState(path: string): { dirty: boolean; missing: boolean } | undefined {
    const known = this.deps.cache.list().find((entry) => entry.path === path);
    const text = this.deps.cache.read(path);

    if (text === undefined) {
      return known ? { dirty: true, missing: true } : undefined;
    }
    return { dirty: known ? known.dirty : true, missing: false };
  }

  /**
   * Sube una edición local. Lo llama el vigilante del directorio.
   *
   * Solo `notas/`: lo demás lo genera el hub y volvería a bajar reescrito, así
   * que subirlo sería pelearse consigo mismo.
   */
  async upload(path: string): Promise<void> {
    if (!path.startsWith(EDITABLE_PREFIX)) return;

    const text = this.deps.cache.read(path);
    if (text === undefined) return;

    try {
      await this.deps.gateway.putFile(path, text);
      this.deps.logger.info(`↑ ${path}`);
    } catch (error) {
      this.deps.logger.warn(`no se pudo subir ${path}: ${describe(error)}`);
    }
  }

  /** Un archivo que desaparece del disco desaparece de la sala. */
  async uploadRemoval(path: string): Promise<void> {
    if (!path.startsWith(EDITABLE_PREFIX)) return;

    try {
      await this.deps.gateway.dropFile(path);
      this.deps.logger.info(`✕ ${path}`);
    } catch (error) {
      this.deps.logger.warn(`no se pudo borrar ${path} en la sala: ${describe(error)}`);
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
