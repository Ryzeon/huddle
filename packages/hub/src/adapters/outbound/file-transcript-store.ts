/**
 * Historial de sesiones en disco.
 *
 * El transcript es la memoria del equipo: lo que se preguntó y se respondió.
 * Perderlo cuando se cierra la sala tiraría justo lo que hace que esto valga
 * más que un chat.
 *
 * Se escribe **al vuelo**, no al cerrar: si el hub se cae de golpe, no hay
 * ningún momento en el que exista información que no esté ya en disco. Un
 * JSONL por sala, que es append-only y sobrevive a una escritura a medias
 * (como mucho se pierde la última línea).
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { TranscriptEntry } from '../../domain/room.js';
import type { TranscriptStorePort } from '../../application/ports/member-channel.js';

export class FileTranscriptStore implements TranscriptStorePort {
  constructor(private readonly dir: string) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  append(roomCode: string, roomName: string, entry: TranscriptEntry): void {
    try {
      appendFileSync(this.fileFor(roomCode), `${JSON.stringify({ roomName, ...entry })}\n`, {
        mode: 0o600,
      });
    } catch {
      // Sin historial se sigue sirviendo; sin hub, no.
    }
  }

  read(roomCode: string): TranscriptEntry[] {
    const file = this.fileFor(roomCode);
    if (!existsSync(file)) return [];

    try {
      return readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => line.trim())
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as TranscriptEntry];
          } catch {
            return []; // línea truncada por una caída: se ignora
          }
        });
    } catch {
      return [];
    }
  }

  /**
   * Descarta lo anterior a `cutoff` y devuelve cuántas entradas quedan.
   *
   * Reescribe el archivo entero en vez de recortarlo: son ficheros pequeños y
   * una reescritura atómica no puede dejar medio JSONL corrupto.
   */
  purge(roomCode: string, cutoff: number): number {
    const file = this.fileFor(roomCode);
    if (!existsSync(file)) return 0;

    const kept = this.read(roomCode).filter((entry) => entry.at >= cutoff);

    try {
      if (kept.length === 0) {
        unlinkSync(file);
        return 0;
      }
      const temp = `${file}.${process.pid}.tmp`;
      writeFileSync(temp, kept.map((e) => `${JSON.stringify(e)}\n`).join(''), { mode: 0o600 });
      renameSync(temp, file);
    } catch {
      // Si falla la purga, mejor conservar de más que perder el historial.
      return kept.length;
    }
    return kept.length;
  }

  /** El código ya viene validado, pero nunca se construyen rutas sin sanear. */
  private fileFor(roomCode: string): string {
    return join(this.dir, `${roomCode.replace(/[^A-Z0-9-]/gi, '_')}.jsonl`);
  }
}
