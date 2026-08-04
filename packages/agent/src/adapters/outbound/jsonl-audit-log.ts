import { appendFileSync } from 'node:fs';
import type { AuditLogPort, LoggerPort } from '../../application/ports/index.js';
import { AUDIT_PATH, ensureHuddleDir } from '../../config.js';

/**
 * Auditoría append-only en JSONL: qué te preguntaron y qué contestaste.
 *
 * Nunca lanza. Un fallo escribiendo el log no debe tumbar al agente ni
 * impedir que se responda una pregunta legítima.
 */
export class JsonlAuditLog implements AuditLogPort {
  constructor(private readonly path: string = AUDIT_PATH) {}

  record(entry: Record<string, unknown>): void {
    try {
      ensureHuddleDir();
      appendFileSync(this.path, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, {
        mode: 0o600,
      });
    } catch {
      // Sin auditoría se sigue; sin agente, no.
    }
  }
}

/** Logger a consola con marca de tiempo corta. */
export class ConsoleLogger implements LoggerPort {
  info(message: string): void {
    console.log(`${stamp()} ${message}`);
  }

  warn(message: string): void {
    console.warn(`${stamp()} ⚠︎ ${message}`);
  }
}

function stamp(): string {
  return new Date().toISOString().slice(11, 19);
}
