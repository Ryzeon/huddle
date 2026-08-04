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

import type { Config, Workspace } from '../config.js';
import { Quota } from '../domain/quota.js';
import { QuestionCache } from '../domain/answer-cache.js';
import { AgentService, WorkspaceAgent } from '../application/agent-service.js';
import {
  AnswerQuestionUseCase,
  type AgentSessionState,
} from '../application/use-cases/answer-question.js';
import {
  systemClock,
  type AuditLogPort,
  type LoggerPort,
  type RoomGatewayPort,
} from '../application/ports/index.js';
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
import { ExpandVocabularyUseCase } from '../application/use-cases/expand-vocabulary.js';
import { VocabularyAwareInspector } from '../application/vocabulary-aware-inspector.js';

export function makeWorkspaceFactory(
  config: Config,
  quota: Quota,
  logger: LoggerPort,
  audit: AuditLogPort,
  gateways: RoomGatewayPort[],
  announceQuota: (remaining: number | null) => void,
): (workspace: Workspace) => WorkspaceAgent {
  return (workspace) =>
    buildWorkspace(config, workspace, quota, logger, audit, gateways, announceQuota);
}

export function buildAgent(config: Config): AgentService {
  const logger = new ConsoleLogger();
  const audit = new JsonlAuditLog();

  // Un solo presupuesto para todos los repositorios: es el de tu plan.
  const quota = new Quota(config.dailyQuota, config.maxConcurrent, {
    store: createQuotaStore(),
  });

  // Se lee al anunciar, no al construir: así incluye también los repositorios
  // añadidos en caliente después de arrancar.
  const gateways: RoomGatewayPort[] = [];
  const announceQuota = (remaining: number | null): void => {
    for (const gateway of gateways) gateway.announcePresence(remaining);
  };

  const workspaces = config.workspaces.map((workspace) =>
    buildWorkspace(config, workspace, quota, logger, audit, gateways, announceQuota),
  );

  return new AgentService(
    {
      workspaces,
      quota,
      logger,
      makeWorkspace: makeWorkspaceFactory(
        config,
        quota,
        logger,
        audit,
        gateways,
        announceQuota,
      ),
    },
    { room: config.room, alias: config.alias },
  );
}

function buildWorkspace(
  config: Config,
  workspace: Workspace,
  quota: Quota,
  logger: LoggerPort,
  audit: AuditLogPort,
  gateways: RoomGatewayPort[],
  announceQuota: (remaining: number | null) => void,
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

  const engine = new ClaudeCodeEngine({
    cwd: workspace.cwd,
    model: config.model,
    effort: config.effort,
    tools: config.tools,
    denyPaths: config.denyPaths,
    timeoutMs: config.timeoutSeconds * 1000,
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
    },
    { card: () => repo.snapshot(), quotaRemaining: () => quota.remaining },
    logger,
  );

  gateways.push(room);

  const answerQuestion = new AnswerQuestionUseCase(
    { engine, room, repo, quota, cache, audit, clock: systemClock, logger, announceQuota },
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
    repo,
    cache,
    answerQuestion,
    state,
    logger,
  });
}

const VOCABULARY_TIMEOUT_MS = 45_000;

function cacheFileFor(workspace: Workspace): string | undefined {
  if (!workspace.tag) return undefined; // el principal usa el nombre por defecto
  const safe = workspace.tag.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `cache-${safe}.json`;
}
