import { appendFileSync } from 'node:fs';
import type { AuditLogPort, LoggerPort } from '../../application/ports/index.js';
import { AUDIT_PATH, ensureHuddleDir } from '../../config.js';

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
