/**
 * Composition root del hub.
 *
 * Único sitio donde se instancian adaptadores concretos y se inyectan en el
 * servicio. Si aparece un `new` de infraestructura fuera de aquí, es una fuga.
 */

import { HubService, DEFAULT_HUB_CONFIG } from '../application/hub-service.js';
import { systemClock, systemTimers } from '../application/ports/member-channel.js';
import { createHttpApi } from '../adapters/inbound/http-api.js';
import { attachWsAdapter } from '../adapters/inbound/ws-server.js';
import { FileTranscriptStore } from '../adapters/outbound/file-transcript-store.js';
import { FileRoomStore } from '../adapters/outbound/file-room-store.js';
import { homedir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.env.HUDDLE_PORT ?? 8787);
const HOST = process.env.HUDDLE_HOST ?? '0.0.0.0';
const HISTORY_DIR = process.env.HUDDLE_HISTORY_DIR ?? join(homedir(), '.huddle-hub', 'historial');
const SWEEP_INTERVAL_MS = 15_000;
const PURGE_INTERVAL_MS = 60 * 60 * 1000;

function log(message: string): void {
  console.log(new Date().toISOString(), message);
}

export function bootstrap(): { close: () => void } {
  const transcripts = new FileTranscriptStore(HISTORY_DIR);
  const rooms = new FileRoomStore(HISTORY_DIR);
  const hub = new HubService(
    { clock: systemClock, timers: systemTimers, transcripts, rooms, log },
    DEFAULT_HUB_CONFIG,
  );

  // Antes de aceptar a nadie: los códigos guardados tienen que funcionar.
  hub.restore();

  const http = createHttpApi(hub);
  // Sin token: el código de sala **es** la llave. Quien lo tiene, entra.
  const wss = attachWsAdapter(http, hub);

  const sweeper = setInterval(() => hub.sweep(), SWEEP_INTERVAL_MS);
  sweeper.unref();
  const purger = setInterval(() => hub.purgeExpired(), PURGE_INTERVAL_MS);
  purger.unref();

  http.listen(PORT, HOST, () => {
    log(`hub escuchando en ws://${HOST}:${PORT} — historial en ${HISTORY_DIR}`);
  });

  return {
    close: () => {
      clearInterval(sweeper);
      clearInterval(purger);
      wss.close();
      http.close();
    },
  };
}

const app = bootstrap();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    log('cerrando…');
    app.close();
    process.exit(0);
  });
}
