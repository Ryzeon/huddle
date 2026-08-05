import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { normalizeAlias } from '@huddle/protocol';
import {
  CONFIG_PATH,
  DEFAULT_CONFIG,
  assignTag,
  loadConfig,
  saveConfig,
  type Config,
  type Workspace,
} from '../../../config.js';
import { callControl, DaemonNotRunningError } from '../control-server.js';
import { fail, flag, usage } from './io.js';
import { addWorkspaceToConfig, removeWorkspaceFromConfig } from './workspaces.js';

export function runJoin(args: string[]): void {
  const [room, alias] = args;
  if (!room || !alias) usage();

  // Sobrescribir en silencio se lleva por delante los repos ya configurados,
  // y el daemon en marcha sigue con la configuración vieja en memoria: quedas
  // con dos verdades distintas y ningún aviso.
  if (existsSync(CONFIG_PATH) && !args.includes('--force')) {
    const existing = loadConfig();
    fail(
      [
        `Ya estás configurado en la sala #${existing.room} como ${existing.alias}.`,
        '',
        'Repos expuestos:',
        ...existing.workspaces.map((w) => `  ${w.tag ? `:${w.tag}` : '(principal)'}  ${w.cwd}`),
        '',
        'Para añadir OTRO repo con la misma cuota:',
        '  huddle add-repo <dir> --tag <nombre>',
        '',
        'Para empezar de cero y perder lo de arriba:',
        '  huddle join ... --force',
      ].join('\n'),
    );
  }

  const cwd = resolve(flag(args, 'cwd') ?? process.cwd());
  const workspace: Workspace = { cwd, tag: flag(args, 'tag') ?? assignTag(cwd, []) };

  const config: Config = {
    ...DEFAULT_CONFIG,
    room,
    alias: normalizeAlias(alias),
    hub: flag(args, 'hub') ?? DEFAULT_CONFIG.hub,
    workspaces: [workspace],
  };

  const token = flag(args, 'token');
  const quota = flag(args, 'quota');
  if (token) config.token = token;
  if (quota) config.dailyQuota = quota === 'none' ? null : Number.parseInt(quota, 10);

  saveConfig(config);

  console.log(`Listo. ${config.alias} → sala #${config.room} exponiendo ${workspace.cwd}`);
  console.log(`Cuota diaria de preguntas entrantes: ${config.dailyQuota ?? 'sin tope'}`);
  console.log('');
  console.log('Ahora:');
  console.log('  1) Arranca el daemon:   huddle daemon');
  console.log('  2) Registra el MCP:     claude mcp add huddle -- huddle mcp');
}

/**
 * Volver a entrar tras una rotación. Solo cambia el código: el alias, el hub y
 * los repositorios ya configurados se quedan como estaban, que es justo lo que
 * `join --force` se llevaría por delante.
 */
export async function runRejoin(args: string[]): Promise<void> {
  const [room] = args;
  if (!room) usage();

  const config = loadConfig();
  saveConfig({ ...config, room });

  try {
    await callControl({ op: 'shutdown' });
    console.log(`Listo: ${config.alias} → sala #${room}. Arranca de nuevo: huddle daemon`);
  } catch (error) {
    if (!(error instanceof DaemonNotRunningError)) throw error;
    console.log(`Listo: ${config.alias} → sala #${room}. Arranca el daemon: huddle daemon`);
  }
}

export async function runAddRepo(args: string[]): Promise<void> {
  const [dir] = args;
  if (!dir) usage();

  const cwd = resolve(dir);
  const tag = flag(args, 'tag');

  try {
    const response = await callControl({ op: 'add_repo', path: cwd, tag });
    if (!response.ok) fail(response.error);
    const added = response.data as { tag?: string };
    console.log(`Añadido ${cwd} como :${added.tag ?? tag ?? '?'}, ya está conectado.`);
    await runListRepos();
    return;
  } catch (error) {
    if (!(error instanceof DaemonNotRunningError)) throw error;
  }

  // Sin daemon: solo queda dejarlo escrito para cuando arranque.
  try {
    const added = addWorkspaceToConfig(cwd, tag);
    console.log(`Añadido ${cwd} como :${added.tag ?? '?'}`);
    console.log('El daemon no está corriendo; se aplicará cuando lo arranques.');
  } catch (error) {
    fail(`${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function runRemoveRepo(args: string[]): Promise<void> {
  const [tagArg] = args;
  if (!tagArg) usage();
  const tag = tagArg.replace(/^:/, '');

  try {
    const response = await callControl({ op: 'remove_repo', tag });
    if (!response.ok) fail(response.error);
    console.log(`Quitado :${tag}, desconectado de la sala.`);
    return;
  } catch (error) {
    if (!(error instanceof DaemonNotRunningError)) throw error;
  }

  try {
    removeWorkspaceFromConfig(tag);
    console.log(`Quitado :${tag}.`);
  } catch (error) {
    fail(`${error instanceof Error ? error.message : String(error)}`);
  }
}

export function runListRepos(): void {
  const config = loadConfig();
  const quota = config.dailyQuota ?? 'sin tope';
  console.log(`${config.alias} en #${config.room}, cuota compartida: ${quota}/día`);

  for (const workspace of config.workspaces) {
    const name = workspace.tag ? `${config.alias}:${workspace.tag}` : config.alias;
    console.log(`  ${name}  ${workspace.cwd}`);
  }
}
