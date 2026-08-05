/**
 * Composition root del agente.
 *
 * Único sitio donde se instancian adaptadores concretos y se inyectan en los
 * casos de uso. Si aparece un `new` de infraestructura fuera de aquí, es una
 * fuga: el dominio y la aplicación solo deben conocer puertos.
 *
 * Lo que se comparte entre repositorios y lo que no:
 *
 *   compartido  →  cuota y concurrencia (son de tu suscripción, no del repo)
 *   por repo    →  caché, inspector de git, motor y conexión a la sala
 *
 * Esa línea es la razón de que todos los repositorios vivan bajo un mismo
 * daemon: dos instalaciones separadas tendrían dos contadores de cuota
 * independientes contra un único plan.
 */

import { FOLDER_DIR, loadConfig, saveConfig, type Config, type Workspace } from '../config.js';
import { Quota } from '../domain/quota.js';
import { QuestionCache } from '../domain/answer-cache.js';
import { PendingRequests } from '../domain/pending-requests.js';
import { AgentService, WorkspaceAgent } from '../application/agent-service.js';
import {
  AnswerQuestionUseCase,
  type AgentSessionState,
} from '../application/use-cases/answer-question.js';
import {
  systemClock,
  type AuditLogPort,
  type IdentitySigner,
  type LoggerPort,
  type RoomGatewayPort,
} from '../application/ports/index.js';
import { loadOrCreateIdentity } from '../identity.js';
import { ClaudeCodeEngine } from '../adapters/outbound/claude/engine.js';
import { ClaudeVocabularyExpander } from '../adapters/outbound/claude/vocabulary-expander.js';
import { GitRepoInspector } from '../adapters/outbound/git-repo-inspector.js';
import { WsRoomGateway } from '../adapters/outbound/ws-room-gateway.js';
import { ConsoleLogger, JsonlAuditLog } from '../adapters/outbound/jsonl-audit-log.js';
import {
  createCacheStore,
  createQuotaStore,
  createVocabularyStore,
} from '../adapters/outbound/fs-stores.js';
import { AskQueue } from '../application/ask-queue.js';
import { ExpandVocabularyUseCase } from '../application/use-cases/expand-vocabulary.js';
import { SyncFolderUseCase } from '../application/use-cases/sync-folder.js';
import { VocabularyAwareInspector } from '../application/vocabulary-aware-inspector.js';
import { FsFolderCache } from '../adapters/outbound/fs-folder-cache.js';
import { FolderWatcher } from '../adapters/inbound/folder-watcher.js';

export function makeWorkspaceFactory(
  config: Config,
  quota: Quota,
  logger: LoggerPort,
  audit: AuditLogPort,
  gateways: RoomGatewayPort[],
  announceQuota: (remaining: number | null) => void,
  queue: AskQueue,
  signer: IdentitySigner,
  pending: PendingRequests,
): (workspace: Workspace) => WorkspaceAgent {
  return (workspace) =>
    buildWorkspace(
      config,
      workspace,
      quota,
      logger,
      audit,
      gateways,
      announceQuota,
      queue,
      signer,
      pending,
    );
}

export function buildAgent(config: Config): AgentService {
  const logger = new ConsoleLogger();
  const audit = new JsonlAuditLog();

  // Una sola clave para toda la instalación: el alias es de la persona, no del
  // repositorio, así que los N gateways firman con la misma.
  const signer = loadOrCreateIdentity();

  // Una sola lista para todos los repositorios: la misma solicitud llega por
  // cada conexión, y verla N veces no es verla N veces.
  const pending = new PendingRequests();

  // Un solo presupuesto para todos los repositorios: es el de tu plan.
  const quota = new Quota(config.dailyQuota, config.maxConcurrent, {
    store: createQuotaStore(),
  });

  // Una sola cola para todos los repositorios, por el mismo motivo que la
  // cuota: el hueco es de tu suscripción, no del repositorio.
  const queue = new AskQueue({ clock: systemClock, logger }, MAX_WAITING);

  // Se lee al anunciar, no al construir: así incluye también los repositorios
  // añadidos en caliente después de arrancar.
  const gateways: RoomGatewayPort[] = [];
  const announceQuota = (remaining: number | null): void => {
    for (const gateway of gateways) gateway.announcePresence(remaining);
  };

  // La copia local de la carpeta es una sola, y la sincroniza un único
  // repositorio: el primero. Los demás la leen —el motor la recibe con
  // `--add-dir`—, pero escribir en ella desde N conexiones sería N daemons
  // peleándose por los mismos archivos.
  const folderCache = new FsFolderCache(FOLDER_DIR);

  const workspaces = config.workspaces.map((workspace, index) =>
    buildWorkspace(
      config,
      workspace,
      quota,
      logger,
      audit,
      gateways,
      announceQuota,
      queue,
      signer,
      pending,
      index === 0 ? folderCache : undefined,
    ),
  );

  const folderSync = workspaces[0]?.folderSync;

  return new AgentService(
    {
      workspaces,
      quota,
      logger,
      pending,
      ...(folderSync && { folderWatcher: new FolderWatcher({ sync: folderSync, logger }) }),
      makeWorkspace: makeWorkspaceFactory(
        config,
        quota,
        logger,
        audit,
        gateways,
        announceQuota,
        queue,
        signer,
        pending,
      ),
      onCodeRotated: (code) => rememberCode(config, code, logger),
    },
    { room: config.room, alias: config.alias, hub: config.hub },
  );
}

/**
 * Guarda el código nuevo. Se relee el archivo antes de escribir porque entre
 * medias pueden haberse añadido repositorios, y escribir la configuración con
 * la que arrancó el daemon se los llevaría por delante.
 */
function rememberCode(config: Config, code: string, logger: LoggerPort): void {
  config.room = code;
  try {
    saveConfig({ ...loadConfig(), room: code });
  } catch (error) {
    logger.warn(
      `el código nuevo es ${code}, pero no se pudo guardar: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function buildWorkspace(
  config: Config,
  workspace: Workspace,
  quota: Quota,
  logger: LoggerPort,
  audit: AuditLogPort,
  gateways: RoomGatewayPort[],
  announceQuota: (remaining: number | null) => void,
  queue: AskQueue,
  signer: IdentitySigner,
  pending: PendingRequests,
  /** Solo el repositorio que sincroniza la carpeta lo recibe. */
  folderCache?: FsFolderCache,
): WorkspaceAgent {
  // El inspector de git dice de qué trata el repositorio con sus propias
  // palabras; el decorador le añade aquellas con las que otros lo buscarían.
  const repo = new VocabularyAwareInspector(
    new GitRepoInspector(workspace.cwd),
    new ExpandVocabularyUseCase(
      {
        expander: new ClaudeVocabularyExpander({
          model: config.model,
          timeoutMs: VOCABULARY_TIMEOUT_MS,
        }),
        store: createVocabularyStore(),
        logger,
      },
      { timeoutMs: VOCABULARY_TIMEOUT_MS },
    ),
  );

  // Caché por repositorio: una respuesta sobre el repo A no debe servir para
  // una pregunta parecida sobre el repo B.
  const cache = new QuestionCache(config.cacheTtlHours, {
    store: createCacheStore(cacheFileFor(workspace)),
  });

  // La carpeta se le pasa a TODOS los motores, aunque solo uno la sincronice:
  // el contexto de la sala vale para responder sobre cualquier repositorio.
  const engine = new ClaudeCodeEngine({
    cwd: workspace.cwd,
    model: config.model,
    effort: config.effort,
    tools: config.tools,
    denyPaths: config.denyPaths,
    timeoutMs: config.timeoutSeconds * 1000,
    folderDir: FOLDER_DIR,
  });

  // Estado que sobrevive entre preguntas de *este* repositorio: la sesión del
  // dueño de la que forkear y el último aviso de límite de la suscripción.
  const state: AgentSessionState = {};

  const room = new WsRoomGateway(
    {
      hubUrl: config.hub,
      room: config.room,
      alias: config.alias,
      tag: workspace.tag,
      token: config.token,
      signer,
      requireSignedJoin: config.requireSignedJoin,
    },
    { card: () => repo.snapshot(), quotaRemaining: () => quota.remaining },
    logger,
  );

  gateways.push(room);

  const answerQuestion = new AnswerQuestionUseCase(
    { engine, room, repo, quota, cache, audit, clock: systemClock, logger, announceQuota, queue },
    {
      blocked: config.blocked,
      dailyQuota: config.dailyQuota,
      forkFromSession: config.forkFromSession,
    },
    state,
  );

  return new WorkspaceAgent({
    tag: workspace.tag,
    room,
    pending,
    repo,
    cache,
    answerQuestion,
    state,
    logger,
    ...(folderCache && {
      folderSync: new SyncFolderUseCase({ cache: folderCache, gateway: room, logger }),
    }),
  });
}

const VOCABULARY_TIMEOUT_MS = 45_000;

/**
 * Cuántas preguntas pueden esperar turno. Con el tope por defecto de una
 * simultánea, esto es una cola de cinco; más allá es más honesto decir que no
 * que dejar a alguien esperando media hora.
 */
const MAX_WAITING = 5;

function cacheFileFor(workspace: Workspace): string | undefined {
  if (!workspace.tag) return undefined; // el principal usa el nombre por defecto
  const safe = workspace.tag.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `cache-${safe}.json`;
}
