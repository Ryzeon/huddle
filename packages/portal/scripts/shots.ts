/**
 * Capturas del modo demo con Chrome headless.
 *
 * `--virtual-time-budget` adelanta los temporizadores de la página, así que
 * cada captura es un instante concreto del guion, reproducible. Bajo tiempo
 * virtual las animaciones no avanzan, y por eso la mesa deja siempre a cada
 * elemento en su estado final y usa la animación solo como camino hasta él
 * (ver `table-view.ts`). Si eso se rompe, se nota aquí.
 *
 *   npm run shots -w @huddle/portal          usa un portal ya levantado
 *   PORTAL_PORT=5173 npm run shots -w @huddle/portal
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)));
const OUT_DIR = join(PACKAGE_DIR, 'preview');
const BASE = `http://127.0.0.1:${process.env['PORTAL_PORT'] ?? 5173}`;

const CHROME =
  process.env['CHROME_BIN'] ??
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

interface Shot {
  file: string;
  query: string;
  width: number;
  height: number;
  /** Instante del guion, en ms. */
  at: number;
  flags?: string[];
}

const SHOTS: Shot[] = [
  // Va primero a propósito: Chrome reutiliza el proceso del primer
  // navegador que lanza, así que las banderas de los siguientes se ignoran en
  // silencio. Esta es la única captura que depende de una bandera.
  {
    file: 'sin-animacion.png',
    query: 'demo=1&tema=oscuro',
    width: 1440,
    height: 900,
    at: 12_600,
    flags: ['--force-prefers-reduced-motion'],
  },
  { file: 'oscuro.png', query: 'demo=1&tema=oscuro&estatico=1', width: 1440, height: 900, at: 12_600 },
  { file: 'claro.png', query: 'demo=1&tema=claro&estatico=1', width: 1440, height: 900, at: 12_600 },
  // `estatico=1`: bajo tiempo virtual el reloj de animación no acompaña y el
  // trazo saldría a medias. La curva es exactamente la misma, ya asentada.
  { file: 'respuesta.png', query: 'demo=1&tema=oscuro&estatico=1', width: 1440, height: 900, at: 9_200 },
  { file: 'portatil.png', query: 'demo=1&tema=oscuro&estatico=1', width: 1280, height: 760, at: 12_600 },
  { file: 'estrecho.png', query: 'demo=1&tema=claro&estatico=1', width: 860, height: 1000, at: 12_600 },
  // Sin sala: lo primero que ve alguien que abre el portal a pelo.
  { file: 'vacio.png', query: 'tema=oscuro&estatico=1', width: 1440, height: 900, at: 800 },
];

mkdirSync(OUT_DIR, { recursive: true });

for (const shot of SHOTS) {
  const target = join(OUT_DIR, shot.file);
  const result = spawnSync(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--force-device-scale-factor=2',
      `--window-size=${shot.width},${shot.height}`,
      `--virtual-time-budget=${shot.at}`,
      `--screenshot=${target}`,
      ...(shot.flags ?? []),
      `${BASE}/?${shot.query}`,
    ],
    { encoding: 'utf8' },
  );
  if (result.error) {
    console.error(`no se pudo lanzar Chrome (${CHROME}):`, result.error.message);
    process.exit(1);
  }
  console.log(`${shot.file}  ${shot.width}×${shot.height}  t=${shot.at} ms`);
}

console.log(`\ncapturas en ${OUT_DIR}`);
