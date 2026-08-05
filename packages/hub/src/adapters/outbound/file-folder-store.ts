/**
 * La carpeta de cada sala en disco.
 *
 * Un JSON por sala, escrito con temporal + rename. No son archivos sueltos en
 * un directorio a propósito: las rutas vienen de fuera, y aunque
 * `normalizeFolderPath` ya las acota, materializarlas como rutas reales del
 * sistema de archivos convierte cada descuido futuro en una escritura fuera de
 * sitio. Aquí una ruta es un dato, no un camino.
 *
 * La copia legible —la que se abre en un editor de notas— es la que el daemon
 * sincroniza en cada máquina. Esta es solo la fuente de la verdad.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FolderFile } from '../../domain/folder.js';
import type { FolderStorePort } from '../../application/ports/member-channel.js';

export class FileFolderStore implements FolderStorePort {
  constructor(private readonly dir: string) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  read(roomCode: string): FolderFile[] {
    const file = this.fileFor(roomCode);
    if (!existsSync(file)) return [];

    try {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(isFolderFile);
    } catch {
      // Una carpeta corrupta no puede impedir que la sala arranque: se pierde
      // lo escrito, que es malo, pero perder la sala entera es peor.
      return [];
    }
  }

  write(roomCode: string, files: readonly FolderFile[]): void {
    const file = this.fileFor(roomCode);
    if (files.length === 0) {
      this.purge(roomCode);
      return;
    }

    const temp = `${file}.${process.pid}.tmp`;
    try {
      writeFileSync(temp, `${JSON.stringify(files)}\n`, { mode: 0o600 });
      renameSync(temp, file);
    } catch {
      if (existsSync(temp)) {
        try {
          unlinkSync(temp);
        } catch {
          /* nada que hacer */
        }
      }
    }
  }

  purge(roomCode: string): void {
    const file = this.fileFor(roomCode);
    if (!existsSync(file)) return;
    try {
      unlinkSync(file);
    } catch {
      /* si falla, la retención volverá a intentarlo */
    }
  }

  rename(from: string, to: string): boolean {
    const origen = this.fileFor(from);
    const destino = this.fileFor(to);
    if (!existsSync(origen)) return true; // una sala sin carpeta se "mueve" sola
    if (existsSync(destino)) return false;

    try {
      renameSync(origen, destino);
      return true;
    } catch {
      return false;
    }
  }

  /** El código ya viene validado, pero nunca se construyen rutas sin sanear. */
  private fileFor(roomCode: string): string {
    return join(this.dir, `${roomCode.replace(/[^A-Z0-9-]/gi, '_')}.json`);
  }
}

function isFolderFile(value: unknown): value is FolderFile {
  if (typeof value !== 'object' || value === null) return false;
  const file = value as Record<string, unknown>;
  return (
    typeof file.path === 'string' &&
    typeof file.text === 'string' &&
    typeof file.by === 'string' &&
    typeof file.at === 'number'
  );
}
