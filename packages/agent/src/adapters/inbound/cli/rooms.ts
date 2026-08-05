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

  const policyFlag = flag(args, 'policy');
  if (policyFlag && policyFlag !== 'open' && policyFlag !== 'approved') {
    fail(`política desconocida: "${policyFlag}". Usa "open" o "approved".`);
  }
  const policy = policyFlag === 'approved' ? 'approved' : undefined;

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
  const code = await agent.createRoom(name, policy);
  saveConfig({ ...config, room: code });

  printRoomCreated(name, code, policy === 'approved');

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

interface PendingRow {
  id: string;
  alias: string;
  key: string;
  repo?: string;
  knownAlias?: string;
}

export async function runPending(): Promise<void> {
  const response = await callControl({ op: 'pending' });
  if (!response.ok) fail(response.error);

  const rows = response.data as PendingRow[];
  if (rows.length === 0) {
    console.log('No hay nadie esperando a entrar.');
    return;
  }

  console.log('Esperando a entrar:');
  console.log('');
  for (const row of rows) {
    const conocido = row.knownAlias ? `  (ya entró antes como ${row.knownAlias})` : '';
    console.log(`  ${row.alias}   clave …${row.key}${conocido}`);
    if (row.repo) console.log(`    repositorio: ${row.repo}`);
    console.log(`    huddle admit ${row.id}     huddle deny ${row.id}`);
    console.log('');
  }
  console.log('Comprueba la clave con esa persona por otro canal antes de dejarla entrar.');
}

export async function runAdmit(args: string[]): Promise<void> {
  const [id] = args;
  if (!id) usage();

  const remember = !args.includes('--once');
  const response = await callControl({ op: 'admit', id, remember });
  if (!response.ok) fail(response.error);

  console.log(
    remember
      ? 'Dentro. La próxima vez entrará sin preguntar.'
      : 'Dentro, solo por esta vez.',
  );
}

export async function runDeny(args: string[]): Promise<void> {
  const [id] = args;
  if (!id) usage();

  const response = await callControl({ op: 'deny', id, reason: flag(args, 'reason') });
  if (!response.ok) fail(response.error);
  console.log('Rechazado.');
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

function printRoomCreated(name: string, code: string, approved: boolean): void {
  console.log('');
  console.log(`  Sala "${name}" creada.`);
  console.log('');
  console.log(`  CÓDIGO:  ${code}`);
  console.log('');

  if (approved) {
    console.log('  Con aprobación: el código no basta, tú decides quién entra.');
    console.log(`  Ellos:   huddle join ${code} @sualias`);
    console.log('  Tú:      huddle pending → huddle admit <id>');
    console.log('');
    console.log('  Comprueba la clave de cada uno con esa persona antes de dejarla entrar.');
  } else {
    console.log('  Pásaselo a tu equipo. Es la única llave: quien lo tiene, entra.');
    console.log(`  Ellos:   huddle join ${code} @sualias`);
  }

  console.log('');
  console.log('  Eres el anfitrión: puedes expulsar con `huddle kick @alguien`.');
  console.log('');
}
