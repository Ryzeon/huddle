/**
 * Fachada de aplicación del agente.
 *
 * Es lo que ven los adaptadores de entrada (socket de control, MCP, CLI).
 * Coordina N repositorios bajo un único presupuesto: la cuota y el límite de
 * concurrencia son de la suscripción de la persona, no de cada repositorio.
 */

import { normalizeFolderPath, type FolderEntry, type Target } from '@huddle/protocol';
import type { Quota } from '../domain/quota.js';
import type { PendingRequest, PendingRequests } from '../domain/pending-requests.js';
import type { QuestionCache } from '../domain/answer-cache.js';
import { AnswerQuestionUseCase, type AgentSessionState } from './use-cases/answer-question.js';
import type {
  IncomingQuestion,
  LoggerPort,
  OutboundResult,
  RepoInspectorPort,
  RoomEventHandlers,
  RoomGatewayPort,
  RoomOptions,
  RosterEntry,
} from './ports/index.js';
import type { SyncFolderUseCase } from './use-cases/sync-folder.js';

export interface WorkspaceAgentDeps {
  tag?: string;
  room: RoomGatewayPort;
  /** Compartido entre repositorios: la solicitud llega por todas las conexiones. */
  pending?: PendingRequests;
  /**
   * Solo lo tiene un repositorio. La carpeta es de la sala y la copia local es
   * una sola: sincronizarla desde N conexiones sería N escrituras del mismo
   * archivo peleándose por el mismo disco.
   */
  folderSync?: SyncFolderUseCase;
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

  /** Lo tiene solo el repositorio que sostiene la copia local de la carpeta. */
  get folderSync(): SyncFolderUseCase | undefined {
    return this.deps.folderSync;
  }

  start(): void {
    this.deps.room.connect(this.handlers());
  }

  createRoom(name: string, options?: RoomOptions): Promise<string> {
    return this.deps.room.create(name, this.handlers(), options);
  }

  admit(id: string, remember?: boolean): void {
    this.deps.room.admit(id, remember);
  }

  deny(id: string, reason?: string): void {
    this.deps.room.deny(id, reason);
  }

  private handlers(): RoomEventHandlers {
    return {
      onQuestion: (question) => this.handle(question),
      onJoinRequest: (request) => this.deps.pending?.add(request),
      onJoinRequestGone: (id) => this.deps.pending?.remove(id),
      onFolderState: (entries) => {
        void this.deps.folderSync?.apply(entries).catch((error: unknown) => {
          this.deps.logger.warn(`no se pudo sincronizar la carpeta: ${String(error)}`);
        });
      },
    };
  }

  closeRoom(reason?: string): void {
    this.deps.room.closeRoom(reason);
  }

  kick(alias: string, reason?: string): void {
    this.deps.room.kick(alias, reason);
  }

  rotateCode(reason?: string): Promise<string> {
    return this.deps.room.rotateCode(reason);
  }

  useRoomCode(code: string): void {
    this.deps.room.useRoomCode(code);
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
  /** Deja el código nuevo escrito, para que el daemon reconecte con él. */
  onCodeRotated?: (code: string) => void;
  pending?: PendingRequests;
  /**
   * Vigila la copia local para subir lo que se edite a mano. Vive aquí y no en
   * un repositorio porque la carpeta es de la sesión, no de ningún repo.
   */
  folderWatcher?: { start(): void; stop(): void };
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
    this.deps.folderWatcher?.start();
  }

  stop(): void {
    this.deps.folderWatcher?.stop();
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

  closeRoom(reason?: string): void {
    const primary = this.deps.workspaces[0];
    if (!primary) throw new Error('no hay ningún repositorio configurado');
    primary.closeRoom(reason);
  }

  /**
   * Cambia el código de la sala. Va siempre por el repositorio principal: es
   * el que creó la sala, y el hub solo acepta rotar al anfitrión.
   *
   * El código nuevo se reparte a TODOS los repositorios: los demás acaban de
   * quedarse fuera con un 4006, y sin esto reconectarían con el código muerto.
   */
  async rotateCode(reason?: string): Promise<string> {
    const [primary, ...rest] = this.deps.workspaces;
    if (!primary) throw new Error('no hay ningún repositorio configurado');

    const code = await primary.rotateCode(reason);
    this.identity.room = code;
    for (const workspace of rest) workspace.useRoomCode(code);
    this.deps.onCodeRotated?.(code);
    return code;
  }

  async createRoom(name: string, options?: RoomOptions): Promise<string> {
    const [primary, ...rest] = this.deps.workspaces;
    if (!primary) throw new Error('no hay ningún repositorio configurado');

    const code = await primary.createRoom(name, options);
    for (const workspace of rest) workspace.start();
    return code;
  }

  /** Quién está esperando en la puerta, sin repetidos. */
  pending(): PendingRequest[] {
    return this.deps.pending?.list() ?? [];
  }

  /**
   * Aprobar y rechazar van por el repositorio principal, como cerrar o rotar:
   * el hub solo se lo acepta al anfitrión, y el anfitrión es esa conexión.
   */
  admit(id: string, remember?: boolean): void {
    const primary = this.deps.workspaces[0];
    if (!primary) throw new Error('no hay ningún repositorio configurado');
    primary.admit(id, remember);
  }

  deny(id: string, reason?: string): void {
    const primary = this.deps.workspaces[0];
    if (!primary) throw new Error('no hay ningún repositorio configurado');
    primary.deny(id, reason);
  }

  /** La carpeta de la sala, tal como la anunció el hub. */
  folder(): FolderEntry[] {
    return this.activeGateway()?.folder() ?? [];
  }

  /** Dónde está la copia local, para poder enseñársela a quien pregunte. */
  get folderDir(): string | undefined {
    return this.folderSync()?.dir;
  }

  /**
   * Lee de la copia local y solo baja del hub si allí no está.
   *
   * La copia se pone al día en cada cambio, así que preguntarle al hub por algo
   * que ya tenemos en disco sería un viaje de red para leer lo mismo.
   */
  async readFile(path: string): Promise<string> {
    const clean = normalizeFolderPath(path);
    const local = this.folderSync()?.read(clean);
    if (local !== undefined) return local;

    const gateway = this.requireGateway();
    return gateway.fetchFile(clean);
  }

  async writeFile(path: string, text: string): Promise<{ path: string }> {
    const clean = normalizeFolderPath(path);
    await this.requireGateway().putFile(clean, text);
    return { path: clean };
  }

  async removeFile(path: string): Promise<{ path: string }> {
    const clean = normalizeFolderPath(path);
    await this.requireGateway().dropFile(clean);
    return { path: clean };
  }

  private folderSync(): SyncFolderUseCase | undefined {
    return this.deps.workspaces.find((workspace) => workspace.folderSync)?.folderSync;
  }

  private requireGateway(): RoomGatewayPort {
    const gateway = this.activeGateway();
    if (!gateway) throw new Error('el daemon no está conectado al hub');
    return gateway;
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
