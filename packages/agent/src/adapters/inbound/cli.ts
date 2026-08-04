#!/usr/bin/env node
/**
 * Adaptador de entrada: la línea de comandos.
 *
 *   huddle join <sala> <@alias> [--hub URL] [--token T] [--cwd DIR]
 *   huddle daemon                  # mantiene la presencia y atiende preguntas
 *   huddle mcp                     # servidor MCP (lo lanza Claude Code)
 *   huddle ask <destino> "..."     # preguntar desde la terminal
 *   huddle who | huddle status
 *
 * Solo mapea argumentos a operaciones del servicio y da formato a la salida.
 * Ninguna regla de negocio vive aquí.
 */

import { normalizeAlias } from '@huddle/protocol';
import {
  CONFIG_PATH,
  DEFAULT_CONFIG,
  SOCKET_PATH,
  assertUniqueTags,
  assignTag,
  loadConfig,
  saveConfig,
  type Config,
} from '../../config.js';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildAgent } from '../../composition/container.js';
import type { Workspace } from '../../config.js';
import { callControl, startControlServer, DaemonNotRunningError } from './control-server.js';
import { runMcpServer } from './mcp-server.js';
import type { OutboundResult } from '../../application/ports/index.js';

const DEFAULT_TTL_SECONDS = 120;

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  if (index < 0 || index + 1 >= args.length) return undefined;
  return args[index + 1];
}

function usage(): never {
  console.error(
    [
      'huddle — salas donde el agente de IA de cada quien responde a sus compañeros',
      '',
      'Comandos:',
      '  create "<nombre>" <@alias>  Crear una sala; imprime su código',
      '    --hub <url>          ws://host:8787 (por defecto localhost)',
      '    --cwd <dir>          Repo a exponer (por defecto, el actual)',
      '    --quota <n>          Preguntas entrantes por día',
      '',
      '  join <codigo> <@alias> Entrar con el código que te pasaron',
      '    --hub <url>          ws://host:8787 (por defecto localhost)',
      '    --cwd <dir>          Repo a exponer (por defecto, el actual)',
      '    --tag <nombre>       Etiqueta del repo (por defecto, el nombre de la carpeta)',
      '    --quota <n>          Preguntas entrantes por día (`none` = sin tope)',
      '    --force              Reemplazar una configuración existente',
      '',
      '  add-repo <dir>         Exponer otro repo, con la MISMA cuota',
      '    --tag <nombre>       Opcional: por defecto usa el nombre de la carpeta',
      '  remove-repo <tag>      Dejar de exponer un repo',
      '  repos                  Listar los repos configurados',
      '',
      '  daemon                 Mantener la presencia y atender preguntas',
      '  mcp                    Servidor MCP por stdio (lo lanza tu agente)',
      '  ask <destino> "..."    Preguntar desde la terminal',
      '  kick <@alias>          Expulsar a alguien (solo el anfitrión)',
      '  who                    Quién está en la sala',
      '  status                 Estado de tu agente',
    ].join('\n'),
  );
  process.exit(1);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  switch (command) {
    case 'create':
      return runCreate(args);
    case 'join':
      return runJoin(args);
    case 'kick':
      return runKick(args);
    case 'add-repo':
      return runAddRepo(args);
    case 'remove-repo':
      return runRemoveRepo(args);
    case 'repos':
      return runListRepos();
    case 'daemon':
      return runDaemon();
    case 'mcp':
      return runMcpServer();
    case 'ask':
      return runAsk(args);
    case 'who':
      return runQuery('members');
    case 'status':
      return runQuery('status');
    default:
      usage();
  }
}

function runJoin(args: string[]): void {
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
 * Añadir un repositorio.
 *
 * Si el daemon está vivo se lo pedimos a él, que lo aplica en caliente y
 * guarda la configuración en el mismo paso. Escribir el archivo por nuestra
 * cuenta dejaría lo guardado y lo que corre desincronizados hasta el próximo
 * reinicio — que es justo lo que pasaba antes.
 */
async function runAddRepo(args: string[]): Promise<void> {
  const [dir] = args;
  if (!dir) usage();

  const cwd = resolve(dir);
  const tag = flag(args, 'tag');

  try {
    const response = await callControl({ op: 'add_repo', path: cwd, tag });
    if (!response.ok) fail(response.error);
    const added = response.data as { tag?: string };
    console.log(`Añadido ${cwd} como :${added.tag ?? tag ?? '?'} — ya está conectado.`);
    await runListRepos();
    return;
  } catch (error) {
    if (!(error instanceof DaemonNotRunningError)) throw error;
  }

  // Sin daemon: solo queda dejarlo escrito para cuando arranque.
  const config = loadConfig();
  if (config.workspaces.some((w) => w.cwd === cwd)) fail(`ese repo ya está expuesto: ${cwd}`);

  const taken = config.workspaces.map((w) => w.tag).filter((t): t is string => Boolean(t));
  const assigned = tag ?? assignTag(cwd, taken);
  const workspaces: Workspace[] = [...config.workspaces, { cwd, tag: assigned }];

  try {
    assertUniqueTags(workspaces);
  } catch (error) {
    fail(
      `${error instanceof Error ? error.message : String(error)}\n` +
        'Ponle una etiqueta distinta con --tag <nombre>',
    );
  }

  saveConfig({ ...config, workspaces });
  console.log(`Añadido ${cwd} como :${assigned}`);
  console.log('El daemon no está corriendo; se aplicará cuando lo arranques.');
}

async function runRemoveRepo(args: string[]): Promise<void> {
  const [tagArg] = args;
  if (!tagArg) usage();
  const tag = tagArg.replace(/^:/, '');

  try {
    const response = await callControl({ op: 'remove_repo', tag });
    if (!response.ok) fail(response.error);
    console.log(`Quitado :${tag} — desconectado de la sala.`);
    return;
  } catch (error) {
    if (!(error instanceof DaemonNotRunningError)) throw error;
  }

  const config = loadConfig();
  const workspaces = config.workspaces.filter((w) => w.tag !== tag);
  if (workspaces.length === config.workspaces.length) fail(`no hay ningún repo con el tag "${tag}"`);
  if (workspaces.length === 0) fail('no puedes quitar el último repo');

  saveConfig({ ...config, workspaces });
  console.log(`Quitado :${tag}.`);
}

async function runListRepos(): Promise<void> {
  const config = loadConfig();
  console.log(`${config.alias} en #${config.room} — cuota compartida: ${config.dailyQuota ?? 'sin tope'}/día`);
  for (const workspace of config.workspaces) {
    const name = workspace.tag ? `${config.alias}:${workspace.tag}` : config.alias;
    console.log(`  ${name}  ${workspace.cwd}`);
  }
}

async function runCreate(args: string[]): Promise<void> {
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

  // Esta terminal SE QUEDA como daemon. Si saliéramos, la sala se quedaría
  // sin nadie dentro y se cerraría al instante — por diseño.
  console.log('  Este proceso es ahora tu daemon. Déjalo abierto.');
  serveControl(agent, true);
}

async function runKick(args: string[]): Promise<void> {
  const [alias] = args;
  if (!alias) usage();

  const target = normalizeAlias(alias);
  const response = await callControl({ op: 'kick', alias: target, reason: flag(args, 'reason') });
  if (!response.ok) fail(response.error);

  // El hub responde de forma asíncrona: solo el anfitrión puede expulsar, y
  // saberlo exige mirar la sala. Confirmar de palabra sería mentir.
  await new Promise((r) => setTimeout(r, 1500));
  const after = await callControl({ op: 'members' });
  const present =
    after.ok && (after.data as { alias: string }[]).some((m) => m.alias === target);

  if (present) {
    fail(`${target} sigue en la sala. ¿Seguro que eres el anfitrión? Míralo con \`huddle status\`.`);
  }
  console.log(`Expulsado ${target}.`);
}

function runDaemon(): void {
  serveControl(buildAgent(loadConfig()));
}

/** Abre el socket de control y deja el proceso vivo hasta que lo maten. */
function serveControl(agent: ReturnType<typeof buildAgent>, alreadyStarted = false): void {
  const control = startControlServer({
    ask: (to, question, ttl) => agent.ask(to as never, question, ttl),
    status: () => agent.status(),
    members: () => agent.members(),
    kick: (alias, reason) => {
      agent.kickMember(alias, reason);
      return { ok: true };
    },
    // Config y estado vivo se actualizan juntos: si solo se guardara el
    // archivo, lo que corre y lo que está escrito quedarían desincronizados
    // hasta el próximo reinicio.
    addRepo: (path, tag) => {
      const config = loadConfig();
      const cwd = resolve(path);
      if (config.workspaces.some((w) => w.cwd === cwd)) {
        throw new Error(`ese repositorio ya está expuesto: ${cwd}`);
      }
      const taken = config.workspaces.map((w) => w.tag).filter((t): t is string => Boolean(t));
      const assigned = tag ?? assignTag(cwd, taken);
      const workspaces: Workspace[] = [...config.workspaces, { cwd, tag: assigned }];
      assertUniqueTags(workspaces);

      saveConfig({ ...config, workspaces });
      return agent.addWorkspace({ cwd, tag: assigned });
    },
    removeRepo: (tag) => {
      const config = loadConfig();
      const workspaces = config.workspaces.filter((w) => w.tag !== tag);
      if (workspaces.length === config.workspaces.length) {
        throw new Error(`no hay ningún repositorio con el tag "${tag}"`);
      }
      if (workspaces.length === 0) {
        throw new Error('no puedes quitar el último repositorio');
      }
      saveConfig({ ...config, workspaces });
      agent.removeWorkspace(tag);
      return { removed: tag, remaining: workspaces.length };
    },
    repos: () => loadConfig().workspaces,
  });

  if (!alreadyStarted) agent.start();
  console.log(`socket de control en ${SOCKET_PATH}`);

  const shutdown = (): void => {
    console.log('\ncerrando…');
    agent.stop();
    control.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function runAsk(args: string[]): Promise<void> {
  const [to, ...rest] = args;
  const question = rest.filter((arg) => !arg.startsWith('--')).join(' ');
  if (!to || !question) usage();

  const response = await callControl({ op: 'ask', to, question, ttl: DEFAULT_TTL_SECONDS });
  if (!response.ok) fail(response.error);

  const result = response.data as OutboundResult;
  if (!result.ok) fail(`sin respuesta: ${result.error ?? 'desconocido'}`);

  console.log(`\n${result.answer}\n`);

  if (result.sources?.length) {
    console.log('Fuentes:');
    for (const source of result.sources) {
      console.log(`  ${source.file}${source.line ? `:${source.line}` : ''}`);
    }
  }

  const meta = [
    result.from,
    result.sha ? `@${result.sha}` : undefined,
    result.confidence,
    result.cached ? 'cacheado' : `${Math.round((result.elapsedMs ?? 0) / 1000)}s`,
  ].filter(Boolean);
  console.log(`\n— ${meta.join(' · ')}`);
}

async function runQuery(op: 'status' | 'members'): Promise<void> {
  const response = await callControl({ op });
  console.log(JSON.stringify(response.ok ? response.data : response.error, null, 2));
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
