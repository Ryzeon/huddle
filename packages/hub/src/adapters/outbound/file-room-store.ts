import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RoomRecord, RoomStorePort } from '../../application/ports/member-channel.js';

export class FileRoomStore implements RoomStorePort {
  private readonly file: string;

  constructor(dir: string) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = join(dir, 'salas.json');
  }

  readAll(): RoomRecord[] {
    if (!existsSync(this.file)) return [];
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(isRoomRecord);
    } catch {
      // Archivo corrupto: es mejor arrancar sin salas que no arrancar.
      return [];
    }
  }

  writeAll(rooms: RoomRecord[]): void {
    // Temporal + rename: un corte a media escritura no deja el índice a medias.
    const temp = `${this.file}.${process.pid}.tmp`;
    try {
      writeFileSync(temp, `${JSON.stringify(rooms, null, 2)}\n`, { mode: 0o600 });
      renameSync(temp, this.file);
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
}

function isRoomRecord(value: unknown): value is RoomRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.code === 'string' &&
    typeof record.name === 'string' &&
    typeof record.createdAt === 'number'
  );
}
