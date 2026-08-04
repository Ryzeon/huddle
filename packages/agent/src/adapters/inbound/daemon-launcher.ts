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

import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';
import { SOCKET_PATH } from '../../config.js';

// Arrancar en frío pasa por `npx tsx`, que compila al vuelo: veinte segundos
// se quedaban cortos en la primera vez.
const STARTUP_TIMEOUT_MS = 60_000;
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

  spawnDetachedDaemon();

  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    if (await isDaemonListening(socketPath)) return true;
  }

  throw new Error(
    `el daemon no llegó a arrancar en ${STARTUP_TIMEOUT_MS / 1000}s. ` +
      'Pruébalo a mano con `huddle daemon` para ver el error.',
  );
}

function spawnDetachedDaemon(): void {
  // Mismo ejecutable y mismo entrypoint que el proceso actual: así hereda el
  // HUDDLE_HOME y la instalación desde la que se lanzó el MCP.
  const entrypoint = fileURLToPath(new URL('./cli.js', import.meta.url));

  const child = spawn(process.execPath, [entrypoint, 'daemon'], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env },
  });
  child.unref();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
