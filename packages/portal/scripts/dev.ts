/**
 * Servidor de desarrollo del portal.
 *
 * No hay bundler. TypeScript emite ESM con extensiones `.js` explícitas, que
 * es lo que ya exige `module: NodeNext`, y el navegador lo carga tal cual. Los
 * únicos imports que apuntan fuera del paquete son `import type`, que
 * desaparecen al compilar, así que en el navegador no queda ni una
 * dependencia sin resolver.
 *
 *   npm run dev  -w @huddle/portal     compila en watch y sirve
 *   npm run serve -w @huddle/portal    solo sirve lo ya compilado
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)));
const REPO_ROOT = resolve(PACKAGE_DIR, '..', '..');
const PORT = Number(process.env['PORTAL_PORT'] ?? 5173);
const HOST = process.env['PORTAL_HOST'] ?? '127.0.0.1';
const WATCH = !process.argv.includes('--no-watch');

/** Prefijo de URL → carpeta del disco. El orden importa: gana el más largo. */
const MOUNTS: Array<[string, string]> = [
  ['/dist/', join(PACKAGE_DIR, 'dist')],
  // Lo que el import map del HTML llama `@huddle/protocol`. El navegador no
  // resuelve especificadores de paquete, y el portal necesita el código real
  // de la firma, no solo sus tipos.
  ['/protocol/', join(REPO_ROOT, 'packages', 'protocol', 'dist')],
  ['/brand/', join(REPO_ROOT, 'brand')],
  ['/', join(PACKAGE_DIR, 'public')],
];

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function resolveFile(pathname: string): string | null {
  const clean = decodeURIComponent(pathname.split('?')[0] ?? '/');
  for (const [prefix, dir] of MOUNTS) {
    if (!clean.startsWith(prefix)) continue;
    const relative = clean.slice(prefix.length) || 'index.html';
    const target = resolve(dir, normalize(relative));
    // Sin esto, `/dist/../../../etc/passwd` sale del paquete.
    if (target !== dir && !target.startsWith(dir + sep)) return null;
    return target;
  }
  return null;
}

async function serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? HOST}`);
  let file = resolveFile(url.pathname);

  if (file) {
    const found = await stat(file).catch(() => null);
    if (found?.isDirectory()) file = join(file, 'index.html');
  }

  const exists = file ? await stat(file).catch(() => null) : null;
  if (!file || !exists?.isFile()) {
    // Cualquier ruta desconocida cae en el portal: el estado va en la query.
    file = join(PACKAGE_DIR, 'public', 'index.html');
  }

  response.writeHead(200, {
    'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
    'cache-control': 'no-store',
  });
  createReadStream(file).pipe(response);
}

function startCompiler(): ChildProcess | null {
  if (!WATCH) return null;
  const tsc = join(REPO_ROOT, 'node_modules', '.bin', 'tsc');
  const child = spawn(tsc, ['--build', '--watch', '--preserveWatchOutput', PACKAGE_DIR], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) process.exit(code);
  });
  return child;
}

const compiler = startCompiler();

const server = createServer((request, response) => {
  serve(request, response).catch(() => {
    response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('error del servidor de desarrollo');
  });
});

server.listen(PORT, HOST, () => {
  console.log(`portal en http://${HOST}:${PORT}`);
  console.log(`demo   en http://${HOST}:${PORT}/?demo=1`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    compiler?.kill();
    server.close();
    process.exit(0);
  });
}
