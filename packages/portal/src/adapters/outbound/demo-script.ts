import type { Member } from '@huddle/protocol';
import type { PortalEvent } from '../../domain/session-state.js';
import type { RememberedRoom } from '../../application/ports/room-feed.js';

export interface ScriptedEvent {
  at: number;
  event: PortalEvent;
}

export const DEMO_ROOM = 'MPP8V-7HZS5';
export const DEMO_ROOM_NAME = 'plataforma';
export const DEMO_YOU = '@visita';

const T0 = 1_735_729_200_000; // instante ficticio y estable: los tests no bailan

function member(
  alias: string,
  joinedAtOffset: number,
  repo: string,
  dirs: string[],
  options: { tag?: string; quotaRemaining?: number | null; status?: Member['status'] } = {},
): Member {
  const value: Member = {
    alias,
    joinedAt: T0 + joinedAtOffset,
    status: options.status ?? 'online',
    lastSeen: T0 + joinedAtOffset,
    quotaRemaining: options.quotaRemaining ?? 17,
    card: { repo, dirs },
  };
  if (options.tag !== undefined) value.tag = options.tag;
  return value;
}

const ana = member('@ana', 0, 'plataforma-core', ['src/auth', 'src/billing']);
const bruno = member('@bruno', 1200, 'gateway-api', ['src/http', 'src/routing'], { tag: 'api' });
const carla = member('@carla', 2000, 'facturacion', ['src/tax', 'src/invoices'], {
  tag: 'facturacion',
  quotaRemaining: 4,
});
const you: Member = {
  alias: DEMO_YOU,
  joinedAt: T0 - 200,
  status: 'online',
  lastSeen: T0,
  quotaRemaining: null,
  viewer: true,
};

export const DEMO_SCRIPT: ScriptedEvent[] = [
  { at: 0, event: { t: 'transport', status: 'connecting' } },
  {
    at: 450,
    event: {
      t: 'welcome',
      v: 1,
      room: DEMO_ROOM,
      roomName: DEMO_ROOM_NAME,
      you: DEMO_YOU,
      host: '@ana',
      members: [you, ana],
    },
  },
  { at: 1500, event: { t: 'room_state', members: [you, ana, bruno] } },
  {
    // La carpeta va temprano: quien mira la demostración tiene que ver que la
    // sala trae algo escrito antes de que empiecen las preguntas.
    at: 2100,
    event: {
      t: 'folder_state',
      write: 'all',
      entries: [
        { path: 'README.md', size: 620, by: '@ana', at: T0 },
        { path: 'notas/convenciones.md', size: 1_240, by: '@ana', at: T0 + 600 },
        { path: 'gente/carla.md', size: 180, by: '@carla', at: T0 + 8_800 },
        { path: 'temas/facturacion.md', size: 210, by: '@carla', at: T0 + 8_800 },
      ],
    },
  },
  { at: 2600, event: { t: 'room_state', members: [you, ana, bruno, carla] } },
  {
    at: 3400,
    event: { t: 'msg', from: '@ana', text: '¿alguien sabe dónde se valida el IVA de las facturas?' },
  },
  { at: 4200, event: { t: 'activity', id: 'q1', from: '@bruno', to: '@carla', phase: 'asking' } },
  {
    at: 7900,
    event: { t: 'activity', id: 'q1', from: '@bruno', to: '@carla', phase: 'answered', elapsedMs: 3680 },
  },
  {
    at: 8600,
    event: { t: 'msg', from: '@carla', text: 'está en src/tax/vat.ts, lo dejé documentado arriba' },
  },
  {
    // Y esa respuesta cae sola en la carpeta: es lo que la convierte en la
    // memoria de la sala en vez de un tablón de anuncios.
    at: 9000,
    event: {
      t: 'folder_state',
      write: 'all',
      entries: [
        { path: 'README.md', size: 620, by: '@ana', at: T0 },
        { path: 'notas/convenciones.md', size: 1_240, by: '@ana', at: T0 + 600 },
        { path: 'respuestas/2026-01-01-carla-donde-se-valida-el-iva-a91f.md', size: 940, by: '@carla', at: T0 + 8_900 },
        { path: 'gente/carla.md', size: 260, by: '@carla', at: T0 + 8_900 },
        { path: 'temas/facturacion.md', size: 300, by: '@carla', at: T0 + 8_900 },
      ],
    },
  },
  { at: 9600, event: { t: 'activity', id: 'q2', from: '@ana', to: '@bruno', phase: 'asking' } },
  {
    at: 10400,
    event: {
      t: 'activity',
      id: 'q2',
      from: '@ana',
      to: '@bruno',
      phase: 'answered',
      elapsedMs: 690,
      cached: true,
    },
  },
  { at: 11600, event: { t: 'activity', id: 'q3', from: '@carla', to: '@ana', phase: 'asking' } },
  {
    at: 15800,
    event: { t: 'activity', id: 'q3', from: '@carla', to: '@ana', phase: 'failed', elapsedMs: 4200 },
  },
  {
    at: 16600,
    event: { t: 'msg', from: '@bruno', text: '@ana se le acabó la cuota de hoy, pregúntame a mí' },
  },
  { at: 18000, event: { t: 'room_state', members: [you, bruno, carla] } },
  { at: 18200, event: { t: 'host_changed', host: '@bruno', reason: 'left' } },
  { at: 19400, event: { t: 'activity', id: 'q4', from: '@carla', to: '@bruno', phase: 'asking' } },
  {
    at: 22600,
    event: { t: 'activity', id: 'q4', from: '@carla', to: '@bruno', phase: 'answered', elapsedMs: 3180 },
  },
  {
    at: 23400,
    event: { t: 'note', text: 'fin del guion de demostración: pulsa «repetir» para verlo otra vez', tone: 'system' },
  },
];

/**
 * Lo que hay dentro de cada archivo de la carpeta en la demostración.
 *
 * Se enseña una nota escrita a mano y una generada por el hub, porque la
 * diferencia entre las dos es justo lo que hay que entender de la carpeta.
 */
export const DEMO_FILES: Record<string, string> = {
  'README.md': `# La carpeta de esta sala

Lo que hay aquí lo ve —y lo lee— el agente de todos los miembros de la sala.

- \`notas/\` es vuestro: se edita a mano y los cambios suben solos.
- \`respuestas/\`, \`temas/\` y \`gente/\` los escribe el hub con cada respuesta.
`,
  'notas/convenciones.md': `# Convenciones del equipo

- Las migraciones se aplican **antes** de desplegar, nunca a la vez.
- El IVA se calcula en un solo sitio: ver [[temas/facturacion]].
- Si algo se decide en una llamada, se escribe aquí el mismo día.
`,
  'respuestas/2026-01-01-carla-donde-se-valida-el-iva-a91f.md': `---
sala: MPP8V-7HZS5
de: "@ana"
a: "@carla"
repo: facturacion · 4f2a1c9
confianza: high
---

# ¿dónde se valida el IVA de las facturas?

En \`src/tax/vat.ts\`, con las tablas por país en \`src/tax/rates/\`.

**Fuentes:** \`src/tax/vat.ts:18\`
**Preguntó** [[gente/ana]] · **respondió** [[gente/carla]]
**Temas:** [[temas/facturacion]]
`,
  'temas/facturacion.md': `# facturacion

Lo que se ha preguntado sobre esto en la sala.
- [[respuestas/2026-01-01-carla-donde-se-valida-el-iva-a91f]]
`,
  'gente/carla.md': `# carla

Lo que ha respondido en esta sala.
- [[respuestas/2026-01-01-carla-donde-se-valida-el-iva-a91f]]
`,
};

export function scriptDuration(script: readonly ScriptedEvent[] = DEMO_SCRIPT): number {
  return script.reduce((max, item) => Math.max(max, item.at), 0);
}

export const DEMO_MEMBERS: Member[] = [you, ana, bruno, carla];

export const DEMO_ROOMS: RememberedRoom[] = [
  { code: DEMO_ROOM, name: DEMO_ROOM_NAME, alias: DEMO_YOU, hub: 'ws://localhost:8787', lastSeen: T0 },
  { code: 'JX4T2-9QW1M', name: 'infra', alias: DEMO_YOU, hub: 'ws://localhost:8787', lastSeen: T0 - 86_400_000 },
  { code: 'B7KD0-3RNC6', name: 'incidencias', alias: DEMO_YOU, hub: 'ws://localhost:8787', lastSeen: T0 - 259_200_000 },
];
