import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { normalizeAlias, normalizeTag, type Alias } from '@huddle/protocol';

export const HUDDLE_DIR = process.env.HUDDLE_HOME ?? join(homedir(), '.huddle');
export const CONFIG_PATH = join(HUDDLE_DIR, 'config.json');
export const AUDIT_PATH = join(HUDDLE_DIR, 'audit.jsonl');

/**
 * La copia local de la carpeta de la sala.
 *
 * Una sola para toda la instalación, no una por sala: la configuración tiene
 * un único `room`, así que solo se está en una a la vez. Al cambiar de sala,
 * la sincronización borra lo que ya no está y la deja limpia sola.
 */
export const FOLDER_DIR = join(HUDDLE_DIR, 'carpeta');

/**
 * `sun_path` son 104 bytes en macOS y 108 en Linux, y `listen()` falla con
 * EINVAL si te pasas — un error que no dice nada útil. Dejamos margen.
 */
const MAX_UNIX_SOCKET_PATH = 96;

function digestOf(dir: string): string {
  return createHash('sha256').update(dir).digest('hex').slice(0, 12);
}

/**
 * Dónde escucha el socket de control.
 *
 * Windows no tiene sockets de dominio unix: `net.listen()` solo acepta named
 * pipes bajo `\\.\pipe\`. Pasarle una ruta de archivo falla al arrancar, así
 * que la plataforma decide la forma del nombre.
 *
 * En unix va junto a la configuración, salvo que la ruta se pase del límite de
 * `sun_path` (104 bytes en macOS, 108 en Linux) — ahí caemos al temporal.
 */
export function resolveSocketPath(dir: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    // Los named pipes no son rutas del sistema de archivos: son un espacio de
    // nombres propio y plano, así que no aplica ningún límite de longitud.
    return `\\\\.\\pipe\\huddle-${digestOf(dir)}`;
  }

  const preferred = join(dir, 'daemon.sock');
  if (Buffer.byteLength(preferred) <= MAX_UNIX_SOCKET_PATH) return preferred;

  // Derivado del directorio: mismo home, mismo socket entre reinicios.
  return join(tmpdir(), `huddle-${digestOf(dir)}.sock`);
}

export const SOCKET_PATH = resolveSocketPath(HUDDLE_DIR);

export interface Workspace {
  cwd: string;
  tag?: string;
}

export interface Config {
  hub: string;
  room: string;
  alias: Alias;
  token?: string;

  /**
   * Repositorios que este agente expone. Uno por tag.
   *
   * Van juntos en una sola configuración —y bajo un solo daemon— a propósito:
   * la cuota y el límite de concurrencia son de **tu suscripción**, no del
   * repositorio. Partirlos en dos instalaciones te daría dos contadores
   * independientes contra un único plan, justo lo que el tope debe evitar.
   */
  workspaces: Workspace[];

  model: string;
  escalateModel: string;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';

  dailyQuota: number | null;
  /** Preguntas simultáneas que aceptas. Una suscripción no quiere más de 2. */
  maxConcurrent: number;
  /** Corte de reloj de pared por pregunta, en segundos. */
  timeoutSeconds: number;

  autoAllow: Alias[];
  blocked: Alias[];
  approvalMode: 'auto' | 'ask';

  denyPaths: string[];
  tools: string[];

  forkFromSession: boolean;
  cacheTtlHours: number;

  /**
   * Cortar si el hub no pide firmar el alias. Por defecto `false`: sobre
   * `ws://` sin TLS, quien esté en medio puede quitar el reto y la firma solo
   * vale de verdad con `wss://` o con esto en `true`.
   */
  requireSignedJoin: boolean;
}

export const DEFAULT_CONFIG: Config = {
  hub: 'ws://localhost:8787',
  room: '',
  alias: '@yo',
  workspaces: [],
  model: 'sonnet',
  escalateModel: 'opus',
  effort: 'low',
  dailyQuota: 20,
  maxConcurrent: 1,
  timeoutSeconds: 90,
  autoAllow: [],
  blocked: [],
  approvalMode: 'auto',
  denyPaths: [
    '.env',
    '.env.*',
    'secrets/**',
    '**/*.pem',
    '**/*.key',
    '**/id_rsa*',
    '.aws/**',
    '.ssh/**',
    '**/credentials*',
  ],
  tools: ['Read', 'Grep', 'Glob'],
  forkFromSession: false,
  cacheTtlHours: 72,
  requireSignedJoin: false,
};

export function ensureHuddleDir(): void {
  if (!existsSync(HUDDLE_DIR)) mkdirSync(HUDDLE_DIR, { recursive: true, mode: 0o700 });
}

export function loadConfig(): Config {
  ensureHuddleDir();
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(
      `no hay config en ${CONFIG_PATH}. Ejecuta: huddle join <codigo> @alias --hub ws://…`,
    );
  }
  const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as Partial<LegacyConfig>;
  const merged: Config = { ...DEFAULT_CONFIG, ...raw, workspaces: readWorkspaces(raw) };
  merged.alias = normalizeAlias(merged.alias);
  merged.autoAllow = (merged.autoAllow ?? []).map(normalizeAlias);
  merged.blocked = (merged.blocked ?? []).map(normalizeAlias);
  if (!merged.room) throw new Error('config sin `room`');
  if (merged.workspaces.length === 0) throw new Error('config sin repositorios');
  assertUniqueTags(merged.workspaces);
  return merged;
}

interface LegacyConfig extends Config {
  cwd?: string;
  tag?: string;
}

function readWorkspaces(raw: Partial<LegacyConfig>): Workspace[] {
  if (Array.isArray(raw.workspaces) && raw.workspaces.length > 0) {
    return raw.workspaces.map(withNormalTag);
  }
  if (typeof raw.cwd === 'string') {
    const migrated: Workspace = { cwd: raw.cwd };
    if (raw.tag) migrated.tag = raw.tag;
    return [withNormalTag(migrated)];
  }
  return [];
}

/**
 * El hub valida el tag normalizado, así que la firma del alias se calcula
 * sobre él: guardar `API` y firmar `API` hace que el hub verifique `api` y la
 * firma no valide.
 */
function withNormalTag(workspace: Workspace): Workspace {
  return workspace.tag ? { ...workspace, tag: normalizeTag(workspace.tag) } : workspace;
}

/**
 * Dos repositorios con el mismo tag colisionarían en el hub: el segundo
 * expulsaría al primero por tener idéntico `alias:tag`.
 */
export function assertUniqueTags(workspaces: Workspace[]): void {
  const seen = new Set<string>();
  for (const workspace of workspaces) {
    const key = workspace.tag ?? '';
    if (seen.has(key)) {
      throw new Error(
        workspace.tag
          ? `hay dos repositorios con el tag "${workspace.tag}"`
          : 'hay dos repositorios sin tag; ponle una etiqueta a uno con --tag',
      );
    }
    seen.add(key);
  }
}

const MAX_TAG_LENGTH = 24;

export function tagFromPath(cwd: string): string {
  const base = cwd.replace(/[/\\]+$/, '').split(/[/\\]/).pop() ?? 'repo';
  const clean = base
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_TAG_LENGTH)
    .replace(/-+$/, '');
  return clean || 'repo';
}

/**
 * Asigna un tag libre para `cwd`, evitando los que ya están tomados.
 * Ante una colisión añade un sufijo numérico en vez de fallar.
 */
export function assignTag(cwd: string, taken: readonly string[]): string {
  const base = tagFromPath(cwd);
  if (!taken.includes(base)) return base;

  for (let n = 2; n < 100; n++) {
    // Se recorta la BASE, no el resultado: si el nombre ya llena el máximo,
    // truncar después del sufijo devolvería el mismo texto una y otra vez.
    const suffix = `-${n}`;
    const stem = base.slice(0, MAX_TAG_LENGTH - suffix.length).replace(/-+$/, '');
    const candidate = `${stem}${suffix}`;
    if (!taken.includes(candidate)) return candidate;
  }
  throw new Error(`no se pudo asignar un tag libre para ${cwd}`);
}

export function saveConfig(config: Config): void {
  ensureHuddleDir();
  writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}
