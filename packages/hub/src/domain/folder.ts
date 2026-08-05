/**
 * La carpeta de la sala.
 *
 * No es de nadie: es de la sala. Cualquiera de dentro escribe y lee, y lo que
 * hay en ella se replica en el disco de todos, así que el agente que responde
 * la lee igual que lee su repositorio.
 *
 * Dos clases de archivo conviven aquí, y la diferencia importa:
 *
 *   escritos a mano  →  `notas/`, y la raíz. Los pone una persona.
 *   generados        →  `respuestas/`, `temas/`, `gente/`. Los escribe el hub
 *                       con cada respuesta que se da en la sala.
 *
 * Los generados crecen solos, así que son los únicos que la poda toca. Borrar
 * lo que alguien escribió a mano porque un contador se llenó sería perder lo
 * único que nadie puede regenerar.
 */

import type { Alias, FolderEntry, FolderWrite } from '@huddle/protocol';

export interface FolderFile {
  path: string;
  text: string;
  by: Alias;
  at: number;
}

export const FOLDER_LIMITS = {
  files: 500,
  totalBytes: 8_000_000,
} as const;

/** Lo que escribe el hub. Es lo único que la poda puede tirar. */
export const GENERATED_PREFIXES = ['respuestas/', 'temas/', 'gente/'] as const;

export function isGenerated(path: string): boolean {
  return GENERATED_PREFIXES.some((prefix) => path.startsWith(prefix));
}

export type PutOutcome =
  | { kind: 'ok'; entry: FolderEntry; pruned: string[] }
  | { kind: 'full'; detail: string };

// Uno para todo el módulo: medir bytes no debe costar un objeto por llamada.
const encoder = new TextEncoder();

export function byteLength(text: string): number {
  return encoder.encode(text).length;
}

export class Folder {
  private readonly files = new Map<string, FolderFile>();

  /** Quién puede escribir. Lo decide quien crea la sala y no cambia después. */
  private writePolicy: FolderWrite = 'all';

  /** Si el hub deja escritas las respuestas de la sala. */
  private memoryOn = true;

  get write(): FolderWrite {
    return this.writePolicy;
  }

  get memory(): boolean {
    return this.memoryOn;
  }

  configure(write: FolderWrite, memory: boolean): void {
    this.writePolicy = write;
    this.memoryOn = memory;
  }

  get size(): number {
    return this.files.size;
  }

  get bytes(): number {
    let total = 0;
    for (const file of this.files.values()) total += byteLength(file.text);
    return total;
  }

  get isEmpty(): boolean {
    return this.files.size === 0;
  }

  /**
   * Escribe o reemplaza un archivo.
   *
   * Reemplazar es lo normal, no un caso raro: dos personas editando la misma
   * nota es exactamente lo que hace un cuaderno común, y quien guarda último
   * gana. Cualquier otra cosa —bloqueos, versiones— pediría una UI que aquí no
   * existe.
   */
  put(path: string, text: string, by: Alias, now: number): PutOutcome {
    const incoming = byteLength(text);
    if (incoming > FOLDER_LIMITS.totalBytes) {
      return { kind: 'full', detail: 'ese archivo solo no cabe en la carpeta' };
    }

    const previous = this.files.get(path);
    const previousBytes = previous ? byteLength(previous.text) : 0;
    const extraFiles = previous ? 0 : 1;

    const pruned = this.makeRoom(
      { bytes: incoming - previousBytes, files: extraFiles },
      path,
    );

    if (
      this.files.size + extraFiles > FOLDER_LIMITS.files ||
      this.bytes - previousBytes + incoming > FOLDER_LIMITS.totalBytes
    ) {
      // Se ha podado todo lo generado y sigue sin caber: lo que queda lo
      // escribió alguien a mano, y eso no se tira por un contador.
      return {
        kind: 'full',
        detail:
          `la carpeta está llena (${this.files.size} archivos, ` +
          `${Math.round(this.bytes / 1000)} KB). Borra algo con folder_drop.`,
      };
    }

    const file: FolderFile = { path, text, by, at: now };
    this.files.set(path, file);
    return { kind: 'ok', entry: toEntry(file), pruned };
  }

  drop(path: string): boolean {
    return this.files.delete(path);
  }

  /**
   * Tira lo que no se ha tocado desde `cutoff` y devuelve cuántos quedan.
   *
   * Aquí sí caen también las notas escritas a mano, al revés que en la poda
   * por tamaño. La razón es distinta: la poda protege a la sala de su propia
   * memoria automática, mientras que esto es la retención de la sala entera.
   * Si la carpeta no caducara, una sala abandonada no se cerraría nunca y el
   * hub guardaría para siempre lo que dijo un equipo que ya no existe.
   *
   * Editar un archivo lo renueva, así que una carpeta que alguien usa no
   * caduca.
   */
  purge(cutoff: number): number {
    for (const [path, file] of this.files) {
      if (file.at < cutoff) this.files.delete(path);
    }
    return this.files.size;
  }

  read(path: string): FolderFile | undefined {
    return this.files.get(path);
  }

  /** Ordenada por ruta: así dos clientes ven la misma carpeta en el mismo orden. */
  list(): FolderEntry[] {
    return [...this.files.values()].sort((a, b) => a.path.localeCompare(b.path)).map(toEntry);
  }

  snapshot(): FolderFile[] {
    return [...this.files.values()];
  }

  restore(files: readonly FolderFile[]): void {
    this.files.clear();
    for (const file of files) {
      if (this.files.size >= FOLDER_LIMITS.files) return;
      this.files.set(file.path, { ...file });
    }
  }

  /**
   * Tira lo generado más antiguo hasta que quepa lo que entra, y devuelve qué
   * tiró. Nunca toca lo escrito a mano ni el archivo que se está escribiendo.
   */
  private makeRoom(needed: { bytes: number; files: number }, writing: string): string[] {
    const pruned: string[] = [];

    const candidates = [...this.files.values()]
      .filter((file) => isGenerated(file.path) && file.path !== writing)
      .sort((a, b) => a.at - b.at);

    for (const candidate of candidates) {
      const fits =
        this.files.size + needed.files <= FOLDER_LIMITS.files &&
        this.bytes + needed.bytes <= FOLDER_LIMITS.totalBytes;
      if (fits) break;

      this.files.delete(candidate.path);
      pruned.push(candidate.path);
    }

    return pruned;
  }
}

function toEntry(file: FolderFile): FolderEntry {
  return { path: file.path, size: byteLength(file.text), by: file.by, at: file.at };
}
