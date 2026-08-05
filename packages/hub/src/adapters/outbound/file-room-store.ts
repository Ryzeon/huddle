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
      return parsed.filter(isRoomRecord).map(sanitize);
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

/**
 * Descarta lo que no tenga forma. Una política desconocida se ignora, y con
 * ella la sala queda abierta; una lista de aprobados con basura se tira
 * entera, y entonces todos vuelven a pasar por la puerta. Los dos fallos van
 * hacia el lado que no sorprende a nadie.
 */
function sanitize(record: RoomRecord): RoomRecord {
  const clean: RoomRecord = { ...record };

  if (clean.policy !== 'approved') {
    delete clean.policy;
    delete clean.ownerKey;
    delete clean.approved;
    return clean;
  }

  if (typeof clean.ownerKey !== 'string') delete clean.ownerKey;
  clean.approved = Array.isArray(clean.approved)
    ? clean.approved.filter(
        (entry) =>
          typeof entry?.key === 'string' &&
          typeof entry?.alias === 'string' &&
          typeof entry?.at === 'number',
      )
    : [];

  return clean;
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
