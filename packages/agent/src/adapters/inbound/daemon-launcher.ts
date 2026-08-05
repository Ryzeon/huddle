/**
 * Arranque automático del daemon.
 *
 * El servidor MCP nace y muere con cada sesión de Claude Code; el daemon debe
 * sobrevivirlas. Por eso se lanza **desacoplado**: si heredara stdio o el
 * grupo de procesos, moriría al cerrar la sesión y perderías la presencia en
 * la sala justo por lo que separamos los dos procesos.
 *
 * El propio socket es el candado: si conecta, ya hay un daemon y no se lanza
 * nada. No hace falta un PID file — o hay alguien escuchando o no lo hay.
 *
 * Queda una carrera: dos sesiones de Claude arrancando a la vez pueden lanzar
 * dos daemons. Se resuelve sola porque el hub expulsa al duplicado con 4003 y
 * ese cierre es terminal (ver TERMINAL_CLOSE_CODES): el perdedor se detiene en
 * vez de reconectar en bucle.
 */

import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';
import { SOCKET_PATH } from '../../config.js';

const STARTUP_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 250;

export function isDaemonListening(socketPath = SOCKET_PATH): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(socketPath);
    const settle = (listening: boolean): void => {
      socket.destroy();
      resolve(listening);
    };
    socket.once('connect', () => settle(true));
    socket.once('error', () => settle(false));
  });
}

/**
 * Garantiza que hay un daemon escuchando. Idempotente: si ya existe, no hace
 * nada. Devuelve `true` si tuvo que lanzarlo.
 */
export async function ensureDaemonRunning(socketPath = SOCKET_PATH): Promise<boolean> {
  if (await isDaemonListening(socketPath)) return false;

  const stderr = spawnDetachedDaemon();

  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    if (await isDaemonListening(socketPath)) return true;
  }

  const motivo = stderr();
  throw new Error(
    `el daemon no llegó a arrancar en ${STARTUP_TIMEOUT_MS / 1000}s.` +
      (motivo ? ` Dijo: ${motivo.split('\n')[0] ?? ''}` : '') +
      ' Pruébalo a mano con `huddle daemon` para ver el error completo.',
  );
}

/**
 * Cómo relanzarse a uno mismo como daemon.
 *
 * `./cli.js` solo existe al lado de este módulo cuando corre compilado. Desde
 * fuente el archivo de al lado es `cli.ts`, así que aquel `spawn` lanzaba una
 * ruta inexistente, el hijo moría al instante y, con la salida descartada, el
 * fallo no aparecía en ningún sitio: solo se veía el plazo agotarse.
 */
function resolveEntrypoint(): string[] {
  const candidatos = [
    new URL('./cli.js', import.meta.url),
    new URL('../../../dist/adapters/inbound/cli.js', import.meta.url),
  ].map((url) => fileURLToPath(url));

  for (const candidato of candidatos) {
    if (existsSync(candidato)) return [candidato];
  }

  // Sin compilar: se relanza por el mismo camino por el que arrancó este
  // proceso, sea cual sea (tsx incluido).
  return [...process.execArgv, process.argv[1] ?? ''];
}

/** Devuelve lo que el hijo escriba en stderr, para poder contar por qué murió. */
function spawnDetachedDaemon(): () => string {
  // `detached` y `windowsHide` se pelean: en Windows, `detached` pide una
  // consola nueva y gana, así que la ventana aparece igual. Allí no hace falta,
  // porque un hijo no muere con su padre como sí ocurre en unix. En unix sí es
  // imprescindible, o el daemon se iría con la sesión del MCP.
  const enWindows = process.platform === 'win32';

  const child = spawn(process.execPath, [...resolveEntrypoint(), 'daemon'], {
    detached: !enWindows,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env },
    windowsHide: true,
  });

  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    if (stderr.length < MAX_STDERR) stderr += chunk.toString('utf8');
  });
  child.on('error', (error) => {
    stderr += error.message;
  });
  child.unref();

  return () => stderr.trim();
}

const MAX_STDERR = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
