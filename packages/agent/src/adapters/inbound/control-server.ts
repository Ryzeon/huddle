import { createServer, connect, type Server, type Socket } from 'node:net';
import { chmodSync, existsSync, unlinkSync } from 'node:fs';
import { SOCKET_PATH } from '../../config.js';

export interface ControlRequest {
  op:
    | 'ask'
    | 'status'
    | 'members'
    | 'kick'
    | 'add_repo'
    | 'remove_repo'
    | 'repos'
    | 'shutdown'
    | 'close'
    | 'rotate';
  to?: string;
  question?: string;
  ttl?: number;
  alias?: string;
  reason?: string;
  path?: string;
  tag?: string;
}

export type ControlResponse = { ok: true; data: unknown } | { ok: false; error: string };

export interface ControlHandlers {
  ask(to: string, question: string, ttl: number): Promise<unknown>;
  status(): unknown;
  members(): unknown;
  kick(alias: string, reason?: string): unknown;
  addRepo(path: string, tag?: string): unknown;
  removeRepo(tag: string): unknown;
  repos(): unknown;
  /** Se apaga tras contestar, para que arranque de nuevo con otra sala. */
  shutdown(): unknown;
  closeRoom(reason?: string): unknown;
  rotateCode(reason?: string): Promise<unknown>;
}

const MAX_REQUEST_BYTES = 64 * 1024;

/** Los named pipes de Windows no son rutas del sistema de archivos. */
function isWindowsPipe(socketPath: string): boolean {
  return socketPath.startsWith('\\\\.\\pipe\\') || socketPath.startsWith('\\\\?\\pipe\\');
}

export function startControlServer(
  handlers: ControlHandlers,
  socketPath = SOCKET_PATH,
): Server {
  // En unix, un socket huérfano de un daemon muerto impide escuchar y hay que
  // borrarlo. En Windows no aplica: los named pipes no viven en el sistema de
  // archivos y el sistema los libera solo al morir el proceso.
  if (!isWindowsPipe(socketPath) && existsSync(socketPath)) {
    try {
      unlinkSync(socketPath);
    } catch {
      /* si falla, listen() dará el error real */
    }
  }

  const server = createServer((socket: Socket) => {
    let buffer = '';

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      if (buffer.length > MAX_REQUEST_BYTES) {
        socket.end(JSON.stringify({ ok: false, error: 'petición demasiado grande' }));
        return;
      }

      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex < 0) return;

      const line = buffer.slice(0, newlineIndex);
      buffer = '';
      void dispatch(line, handlers)
        .then((response) => socket.end(`${JSON.stringify(response)}\n`))
        .catch((err: unknown) =>
          socket.end(
            `${JSON.stringify({
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            })}\n`,
          ),
        );
    });

    socket.on('error', () => socket.destroy());
  });

  server.listen(socketPath, () => {
    // Permisos solo en unix. Un named pipe no es un archivo: `chmod` sobre él
    // falla, y su control de acceso ya es por sesión del usuario.
    if (isWindowsPipe(socketPath)) return;
    try {
      chmodSync(socketPath, 0o600);
    } catch {
      /* en algunos FS no aplica; el directorio ya es 0700 */
    }
  });

  return server;
}

async function dispatch(line: string, handlers: ControlHandlers): Promise<ControlResponse> {
  let req: ControlRequest;
  try {
    req = JSON.parse(line) as ControlRequest;
  } catch {
    return { ok: false, error: 'JSON inválido' };
  }

  switch (req.op) {
    case 'ask': {
      if (!req.to || !req.question) {
        return { ok: false, error: 'faltan `to` o `question`' };
      }
      const data = await handlers.ask(req.to, req.question, req.ttl ?? 120);
      return { ok: true, data };
    }
    case 'status':
      return { ok: true, data: handlers.status() };
    case 'members':
      return { ok: true, data: handlers.members() };
    case 'kick': {
      if (!req.alias) return { ok: false, error: 'falta `alias`' };
      return { ok: true, data: handlers.kick(req.alias, req.reason) };
    }
    case 'add_repo': {
      if (!req.path) return { ok: false, error: 'falta `path`' };
      return { ok: true, data: handlers.addRepo(req.path, req.tag) };
    }
    case 'remove_repo': {
      if (!req.tag) return { ok: false, error: 'falta `tag`' };
      return { ok: true, data: handlers.removeRepo(req.tag) };
    }
    case 'repos':
      return { ok: true, data: handlers.repos() };
    case 'close':
      return { ok: true, data: handlers.closeRoom(req.reason) };
    case 'rotate':
      return { ok: true, data: await handlers.rotateCode(req.reason) };
    case 'shutdown':
      return { ok: true, data: handlers.shutdown() };
    default:
      return { ok: false, error: `operación desconocida: ${String(req.op)}` };
  }
}

export class DaemonNotRunningError extends Error {
  constructor() {
    super('el daemon de huddle no está corriendo. Arrancalo con: huddle daemon');
    this.name = 'DaemonNotRunningError';
  }
}

export function callControl(
  req: ControlRequest,
  socketPath = SOCKET_PATH,
  timeoutMs = 180_000,
): Promise<ControlResponse> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let buffer = '';
    let settled = false;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      fn();
    };

    const timer = setTimeout(
      () => finish(() => reject(new Error('el daemon no respondió a tiempo'))),
      timeoutMs,
    );

    socket.on('connect', () => socket.write(`${JSON.stringify(req)}\n`));
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
    });
    socket.on('end', () =>
      finish(() => {
        try {
          resolve(JSON.parse(buffer.trim()) as ControlResponse);
        } catch {
          reject(new Error('respuesta ilegible del daemon'));
        }
      }),
    );
    socket.on('error', (err: NodeJS.ErrnoException) =>
      finish(() =>
        reject(
          err.code === 'ENOENT' || err.code === 'ECONNREFUSED'
            ? new DaemonNotRunningError()
            : err,
        ),
      ),
    );
  });
}
