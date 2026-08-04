/**
 * Fachada de aplicación del agente.
 *
 * Es lo que ven los adaptadores de entrada (socket de control, MCP, CLI).
 * Coordina N repositorios bajo un único presupuesto: la cuota y el límite de
 * concurrencia son de la suscripción de la persona, no de cada repositorio.
 */

import type { Target } from '@huddle/protocol';
import type { Quota } from '../domain/quota.js';
import type { QuestionCache } from '../domain/answer-cache.js';
import { AnswerQuestionUseCase, type AgentSessionState } from './use-cases/answer-question.js';
import type {
  IncomingQuestion,
  LoggerPort,
  OutboundResult,
  RepoInspectorPort,
  RoomGatewayPort,
  RosterEntry,
} from './ports/index.js';

export interface WorkspaceAgentDeps {
  tag?: string;
  room: RoomGatewayPort;
  repo: RepoInspectorPort;
  cache: QuestionCache;
  answerQuestion: AnswerQuestionUseCase;
  state: AgentSessionState;
  logger: LoggerPort;
}

export interface WorkspaceStatus {
  tag: string | null;
  repo: string;
  connected: boolean;
  cacheEntries: number;
  usageLimit: unknown;
}

export class WorkspaceAgent {
  constructor(private readonly deps: WorkspaceAgentDeps) {}

  get tag(): string | undefined {
    return this.deps.tag;
  }

  get gateway(): RoomGatewayPort {
    return this.deps.room;
  }

  start(): void {
    this.deps.room.connect({ onQuestion: (question) => this.handle(question) });
  }

  createRoom(name: string): Promise<string> {
    return this.deps.room.create(name, { onQuestion: (question) => this.handle(question) });
  }

  kick(alias: string, reason?: string): void {
    this.deps.room.kick(alias, reason);
  }

  stop(): void {
    this.deps.room.disconnect();
  }

  private handle(question: IncomingQuestion): void {
    void this.deps.answerQuestion.execute(question).catch((error: unknown) => {
      // El caso de uso ya maneja sus errores; esto es la última red.
      this.deps.logger.warn(
        `fallo no controlado respondiendo a ${question.from}: ${String(error)}`,
      );
    });
  }

  status(): WorkspaceStatus {
    return {
      tag: this.deps.tag ?? null,
      repo: this.deps.repo.snapshot().repo,
      connected: this.deps.room.isConnected(),
      cacheEntries: this.deps.cache.size,
      usageLimit: this.deps.state.usageLimit ?? null,
    };
  }
}

export interface AgentStatus {
  room: string;
  alias: string;
  /** A qué hub. Sin esto se sabe si estás conectado, pero no a dónde. */
  hub: string;
  connected: boolean;
  quotaRemaining: number | null;
  quotaLimit: number | null;
  inFlight: number;
  workspaces: WorkspaceStatus[];
  members: RosterEntry[];
}

export interface AgentServiceDeps {
  workspaces: WorkspaceAgent[];
  quota: Quota;
  logger: LoggerPort;
  makeWorkspace?: (workspace: { cwd: string; tag?: string }) => WorkspaceAgent;
}

export interface AgentIdentity {
  room: string;
  alias: string;
  /** A qué hub. Sin esto se sabe si estás conectado, pero no a dónde. */
  hub: string;
}

export class AgentService {
  constructor(
    private readonly deps: AgentServiceDeps,
    private readonly identity: AgentIdentity,
  ) {}

  start(): void {
    for (const workspace of this.deps.workspaces) workspace.start();
  }

  stop(): void {
    for (const workspace of this.deps.workspaces) workspace.stop();
  }

  ask(to: Target, question: string, ttlSeconds: number): Promise<OutboundResult> {
    const gateway = this.activeGateway();
    if (!gateway) {
      return Promise.resolve({ ok: false, error: 'el daemon no está conectado al hub' });
    }
    return gateway.ask(to, question, ttlSeconds);
  }

  members(): RosterEntry[] {
    return this.activeGateway()?.roster() ?? [];
  }

  kickMember(alias: string, reason?: string): void {
    const primary = this.deps.workspaces[0];
    if (!primary) throw new Error('no hay ningún repositorio configurado');
    primary.kick(alias, reason);
  }

  async createRoom(name: string): Promise<string> {
    const [primary, ...rest] = this.deps.workspaces;
    if (!primary) throw new Error('no hay ningún repositorio configurado');

    const code = await primary.createRoom(name);
    for (const workspace of rest) workspace.start();
    return code;
  }

  addWorkspace(workspace: { cwd: string; tag?: string }): WorkspaceStatus {
    if (!this.deps.makeWorkspace) {
      throw new Error('este agente no admite añadir repositorios en caliente');
    }
    const agent = this.deps.makeWorkspace(workspace);
    this.deps.workspaces.push(agent);
    agent.start();
    this.deps.logger.info(`repositorio añadido en caliente: ${workspace.cwd}`);
    return agent.status();
  }

  removeWorkspace(tag: string): boolean {
    const index = this.deps.workspaces.findIndex((w) => w.tag === tag);
    if (index < 0) return false;

    const [removed] = this.deps.workspaces.splice(index, 1);
    removed?.stop();
    this.deps.logger.info(`repositorio retirado: :${tag}`);
    return true;
  }

  status(): AgentStatus {
    return {
      room: this.identity.room,
      alias: this.identity.alias,
      hub: this.identity.hub,
      connected: this.activeGateway() !== undefined,
      quotaRemaining: this.deps.quota.remaining,
      quotaLimit: this.deps.quota.dailyLimit,
      inFlight: this.deps.quota.busy,
      workspaces: this.deps.workspaces.map((workspace) => workspace.status()),
      members: this.members(),
    };
  }

  private activeGateway(): RoomGatewayPort | undefined {
    return this.deps.workspaces.find((w) => w.gateway.isConnected())?.gateway;
  }
}
