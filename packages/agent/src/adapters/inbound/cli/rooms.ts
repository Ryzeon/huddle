import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { normalizeAlias } from '@huddle/protocol';
import {
  CONFIG_PATH,
  DEFAULT_CONFIG,
  loadConfig,
  saveConfig,
  type Config,
} from '../../../config.js';
import { buildAgent } from '../../../composition/container.js';
import { callControl } from '../control-server.js';
import { serveControl } from './daemon.js';
import { fail, flag, usage } from './io.js';

/** Cuánto se espera al hub antes de comprobar si la expulsión surtió efecto. */
const KICK_SETTLE_MS = 1_500;

export async function runCreate(args: string[]): Promise<void> {
  const [name, alias] = args;
  if (!name || !alias) usage();

  if (existsSync(CONFIG_PATH) && !args.includes('--force')) {
    const existing = loadConfig();
    fail(`Ya estás en la sala ${existing.room}. Usa --force para crear otra y salir de esa.`);
  }

  const workspace = { cwd: resolve(flag(args, 'cwd') ?? process.cwd()) };
  const quota = flag(args, 'quota');

  // La sala aún no existe: `room` se rellena con el código que devuelva el hub.
  const config: Config = {
    ...DEFAULT_CONFIG,
    room: '',
    alias: normalizeAlias(alias),
    hub: flag(args, 'hub') ?? DEFAULT_CONFIG.hub,
    workspaces: [workspace],
  };
  if (quota) config.dailyQuota = quota === 'none' ? null : Number.parseInt(quota, 10);

  const agent = buildAgent({ ...config, room: 'PENDIENTE' });
  const code = await agent.createRoom(name);
  saveConfig({ ...config, room: code });

  printRoomCreated(name, code);

  // Esta terminal se queda como daemon. Si saliéramos, la sala quedaría sin
  // nadie dentro y se cerraría al instante, por diseño.
  console.log('  Este proceso es ahora tu daemon. Déjalo abierto.');
  serveControl(agent, true);
}

export async function runClose(args: string[]): Promise<void> {
  const response = await callControl({ op: 'close', reason: flag(args, 'reason') });
  if (!response.ok) fail(response.error);
  console.log('Sala cerrada. Su código ya no sirve y su historial se ha borrado.');
}

export async function runRotate(args: string[]): Promise<void> {
  const response = await callControl({ op: 'rotate', reason: flag(args, 'reason') });
  if (!response.ok) fail(response.error);

  const { room } = response.data as { room: string };
  printCodeRotated(room);
}

export async function runKick(args: string[]): Promise<void> {
  const [alias] = args;
  if (!alias) usage();

  const target = normalizeAlias(alias);
  const response = await callControl({ op: 'kick', alias: target, reason: flag(args, 'reason') });
  if (!response.ok) fail(response.error);

  // El hub responde de forma asíncrona: solo el anfitrión puede expulsar, y
  // saberlo exige mirar la sala. Confirmar de palabra sería mentir.
  await new Promise((resolveWait) => setTimeout(resolveWait, KICK_SETTLE_MS));
  const after = await callControl({ op: 'members' });
  const present =
    after.ok && (after.data as { alias: string }[]).some((member) => member.alias === target);

  if (present) {
    fail(`${target} sigue en la sala. ¿Seguro que eres el anfitrión? Míralo con \`huddle status\`.`);
  }
  console.log(`Expulsado ${target}.`);
}

function printCodeRotated(code: string): void {
  console.log('');
  console.log('  Código cambiado. El anterior ya no sirve.');
  console.log('');
  console.log(`  CÓDIGO:  ${code}`);
  console.log('');
  console.log('  A todos los demás se les ha cerrado la conexión. Pásales el nuevo:');
  console.log(`  Ellos:   huddle rejoin ${code}`);
  console.log('');
}

function printRoomCreated(name: string, code: string): void {
  console.log('');
  console.log(`  Sala "${name}" creada.`);
  console.log('');
  console.log(`  CÓDIGO:  ${code}`);
  console.log('');
  console.log('  Pásaselo a tu equipo. Es la única llave: quien lo tiene, entra.');
  console.log(`  Ellos:   huddle join ${code} @sualias`);
  console.log('');
  console.log('  Eres el anfitrión: puedes expulsar con `huddle kick @alguien`.');
  console.log('');
}
