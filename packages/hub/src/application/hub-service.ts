import { PROTOCOL_VERSION, type ClientMessage } from '@huddle/protocol';
import type { Room, TranscriptEntry } from '../domain/room.js';
import type { BucketPolicy } from '../domain/rate-limit.js';
import type {
  ClockPort,
  FolderStorePort,
  MemberChannelPort,
  NoncePort,
  RoomStorePort,
  SignatureVerifierPort,
  TimerPort,
  TranscriptStorePort,
} from './ports/member-channel.js';
import { RoomRegistry } from './state/room-registry.js';
import { RoomNotifier } from './state/room-notifier.js';
import { AskTimeouts } from './state/ask-timeouts.js';
import { JoinRoomHandler } from './commands/join-room.js';
import { CreateRoomHandler } from './commands/create-room.js';
import { CloseRoomHandler } from './commands/close-room.js';
import { KickMemberHandler } from './commands/kick-member.js';
import { RotateCodeHandler } from './commands/rotate-code.js';
import { ApproveGuestHandler } from './commands/approve-guest.js';
import { generateRoomCode, normalizeRoomCode } from '../domain/room-code.js';
import { AskQuestionHandler } from './commands/ask-question.js';
import { RelayAnswerHandler } from './commands/relay-answer.js';
import { WriteFolderHandler } from './commands/write-folder.js';
import { RememberAnswerHandler } from './commands/remember-answer.js';
import { LeaveRoomHandler } from './commands/leave-room.js';
import { SweepStaleMembersHandler } from './commands/sweep-stale-members.js';
import { RoomQueries, type HubStats } from './queries/room-queries.js';
import { Challenges } from './state/challenges.js';

export interface HubConfig {
  askPolicy: BucketPolicy;
  retentionMs: number;
  maxTtlSeconds: number;
  heartbeatTimeoutMs: number;
  /** Cuánto se espera en la puerta antes de darse por rechazado. */
  approvalTimeoutMs: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Retos de repuesto para los tests. No son impredecibles: el composition root
 * inyecta siempre los de verdad, y aquí no se puede importar `node:crypto`.
 */
function counterNonces(): NoncePort {
  let n = 0;
  return { next: () => `reto-${++n}` };
}

export const DEFAULT_HUB_CONFIG: HubConfig = {
  askPolicy: { burst: 5, refillMs: 10_000 },
  retentionMs: 30 * DAY_MS,
  maxTtlSeconds: 300,
  heartbeatTimeoutMs: 45_000,
  approvalTimeoutMs: 10 * 60_000,
};

export interface HubDeps {
  clock: ClockPort;
  timers: TimerPort;
  transcripts: TranscriptStorePort;
  /** Sin valor por defecto a propósito: un verificador de mentira acepta todo. */
  verifier: SignatureVerifierPort;
  nonces?: NoncePort;
  rooms?: RoomStorePort;
  /** Sin él la carpeta funciona, pero se va con el proceso. */
  folders?: FolderStorePort;
  log?: (message: string) => void;
  generateCode?: () => string;
}

export class HubService {
  private readonly registry: RoomRegistry;
  private readonly notifier: RoomNotifier;
  private readonly queries: RoomQueries;

  private readonly createRoom: CreateRoomHandler;
  private readonly joinRoom: JoinRoomHandler;
  private readonly kickMember: KickMemberHandler;
  private readonly approveGuest: ApproveGuestHandler;
  private readonly closeRoom: CloseRoomHandler;
  private readonly askQuestion: AskQuestionHandler;
  private readonly relayAnswer: RelayAnswerHandler;
  private readonly leaveRoom: LeaveRoomHandler;
  private readonly rotateCode: RotateCodeHandler;
  private readonly sweepStale: SweepStaleMembersHandler;
  private readonly writeFolder: WriteFolderHandler;

  private readonly clock: ClockPort;
  private readonly transcripts: TranscriptStorePort;
  private readonly roomStore?: RoomStorePort;
  private readonly folderStore?: FolderStorePort;
  private readonly retentionMs: number;
  private readonly log: (message: string) => void;
  private readonly verifier: SignatureVerifierPort;
  private readonly challenges: Challenges;

  constructor(deps: HubDeps, config: HubConfig = DEFAULT_HUB_CONFIG) {
    const log = deps.log ?? (() => undefined);

    this.clock = deps.clock;
    this.transcripts = deps.transcripts;
    this.verifier = deps.verifier;
    this.challenges = new Challenges(deps.nonces ?? counterNonces());
    this.roomStore = deps.rooms;
    this.folderStore = deps.folders;
    this.retentionMs = config.retentionMs;
    this.log = log;
    this.registry = new RoomRegistry(config.askPolicy);
    this.notifier = new RoomNotifier(this.registry);
    this.queries = new RoomQueries(this.registry);

    const timeouts = new AskTimeouts(deps.timers);
    const shared = { registry: this.registry, notifier: this.notifier, timeouts, log };

    const generateCode = deps.generateCode ?? generateRoomCode;
    const identity = { challenges: this.challenges, verifier: this.verifier };
    this.createRoom = new CreateRoomHandler({
      registry: this.registry,
      notifier: this.notifier,
      clock: deps.clock,
      generateCode,
      ...identity,
      log,
    });
    this.joinRoom = new JoinRoomHandler({
      ...shared,
      clock: deps.clock,
      ...identity,
      timers: deps.timers,
      approvalTimeoutMs: config.approvalTimeoutMs ?? DEFAULT_HUB_CONFIG.approvalTimeoutMs,
    });
    this.approveGuest = new ApproveGuestHandler({
      registry: this.registry,
      notifier: this.notifier,
      clock: deps.clock,
      log,
    });
    this.kickMember = new KickMemberHandler({ registry: this.registry, log });
    this.closeRoom = new CloseRoomHandler({
      registry: this.registry,
      transcripts: this.transcripts,
      folders: deps.folders,
      log,
    });
    this.askQuestion = new AskQuestionHandler({
      notifier: this.notifier,
      timeouts,
      clock: deps.clock,
      maxTtlSeconds: config.maxTtlSeconds,
      log,
    });
    this.relayAnswer = new RelayAnswerHandler({
      notifier: this.notifier,
      timeouts,
      clock: deps.clock,
      transcripts: deps.transcripts,
      remember: new RememberAnswerHandler({ notifier: this.notifier, log }),
    });
    this.writeFolder = new WriteFolderHandler({
      notifier: this.notifier,
      clock: deps.clock,
      log,
    });
    this.leaveRoom = new LeaveRoomHandler({ ...shared, notifier: this.notifier });
    this.rotateCode = new RotateCodeHandler({
      ...shared,
      transcripts: this.transcripts,
      folders: deps.folders,
      leaveRoom: this.leaveRoom,
      generateCode,
    });
    this.sweepStale = new SweepStaleMembersHandler({
      registry: this.registry,
      leaveRoom: this.leaveRoom,
      clock: deps.clock,
      heartbeatTimeoutMs: config.heartbeatTimeoutMs,
      log,
    });
  }

  restore(): void {
    const records = this.roomStore?.readAll() ?? [];
    if (records.length === 0) return;
    this.registry.restore(records);

    // La carpeta se recupera después de la sala y por separado: es lo único
    // que puede ocupar megas, y un archivo corrupto ahí no debe llevarse por
    // delante el índice de salas.
    for (const room of this.registry.allRooms()) {
      const files = this.folderStore?.read(room.code) ?? [];
      if (files.length > 0) room.folder.restore(files);
    }

    this.log(`${records.length} sala(s) recuperadas del disco`);
    this.purgeExpired();
  }

  purgeExpired(): void {
    const cutoff = this.clock.now() - this.retentionMs;
    let closed = 0;

    for (const room of this.registry.allRooms()) {
      const remaining = this.transcripts.purge(room.code, cutoff);
      room.replaceTranscript(this.transcripts.read(room.code));

      // La carpeta caduca con los mismos treinta días. Sin esto, la primera
      // respuesta que se anota deja una sala que ya no se cierra nunca.
      if (room.folder.purge(cutoff) === 0) this.folderStore?.purge(room.code);
      else this.persistFolder(room);

      if (remaining === 0 && room.isEmpty && room.folder.isEmpty && room.createdAt < cutoff) {
        this.registry.forget(room.code);
        this.folderStore?.purge(room.code);
        closed += 1;
      }
    }

    if (closed > 0) this.log(`${closed} sala(s) cerradas por antigüedad`);
    this.persistRooms();
  }

  private persistRooms(): void {
    this.roomStore?.writeAll(this.registry.snapshot());
  }

  private persistFolder(room: Room): void {
    this.folderStore?.write(room.code, room.folder.snapshot());
  }

  transcriptOf(roomCode: string): readonly TranscriptEntry[] {
    const code = normalizeRoomCode(roomCode);
    const live = this.queries.transcript(code);
    return live.length > 0 ? live : this.transcripts.read(code);
  }

  stats(): HubStats {
    return this.queries.stats();
  }

  /** El reto sale antes que nada: quien quiera firmar necesita un nonce nuestro. */
  greet(channel: MemberChannelPort): void {
    channel.send({
      t: 'challenge',
      v: PROTOCOL_VERSION,
      nonce: this.challenges.issue(channel.id),
    });
  }

  handle(channel: MemberChannelPort, message: ClientMessage): void {
    if (message.t === 'create') {
      this.createRoom.handle({ channel, message });
      this.persistRooms();
      return;
    }
    if (message.t === 'join') {
      // Un join que ata una clave cambia la sala: sin esto, reiniciar el hub
      // soltaría el vínculo y el alias volvería a estar libre.
      if (this.joinRoom.handle({ channel, message })) this.persistRooms();
      return;
    }

    const room = this.registry.roomOf(channel.id);
    const member = room?.find(channel.id);
    if (!room || !member) {
      // Quien espera en la puerta SÍ mandó join: decirle lo contrario le haría
      // reintentar y volver a ponerse a la cola detrás de sí mismo.
      const esperando = room?.isWaiting(channel.id) === true;
      channel.send({
        t: 'error',
        id: '',
        reason: esperando ? 'denied_by_owner' : 'bad_request',
        detail: esperando
          ? 'sigues esperando a que el anfitrión te deje entrar'
          : 'hay que mandar `join` primero',
      });
      return;
    }

    const now = this.clock.now();

    switch (message.t) {
      case 'ping': {
        // Difundimos solo si la cuota cambió: en cada latido serían N²
        // mensajes cada 20s, pero no hacerlo nunca la deja obsoleta en la UI.
        const { quotaChanged } = room.touch(channel.id, now, message.quotaRemaining);
        channel.send({ t: 'pong' });
        if (quotaChanged) this.notifier.broadcastRoster(room);
        return;
      }

      case 'ask':
        room.touch(channel.id, now);
        this.askQuestion.handle({ room, asker: member, channel, message });
        return;

      case 'msg':
        room.touch(channel.id, now);
        this.notifier.broadcast(room, { t: 'msg', from: member.alias, text: message.text });
        return;

      case 'kick':
        room.touch(channel.id, now);
        this.kickMember.handle({ room, requester: member.alias, channel, message });
        // Expulsar revoca la aprobación: si no se guarda, un reinicio se la
        // devuelve y la expulsión se deshace sola.
        this.persistRooms();
        return;

      case 'admit':
      case 'deny':
        room.touch(channel.id, now);
        this.approveGuest.handle({ room, requester: member.alias, channel, message });
        this.persistRooms();
        return;

      case 'rotate':
        room.touch(channel.id, now);
        this.rotateCode.handle({ room, requester: member.alias, channel, message });
        this.persistRooms();
        return;

      case 'close':
        this.closeRoom.handle({ room, requester: member.alias, channel, message });
        this.persistRooms();
        return;

      // El resto viene del que responde y vuelve a quien preguntó.
      case 'chunk':
      case 'trace':
        room.touch(channel.id, now);
        this.relayAnswer.relayProgress({ room, responder: member.alias, message });
        return;

      case 'result': {
        room.touch(channel.id, now);
        // La respuesta se queda escrita en la carpeta, así que hay que dejarla
        // en disco: si no, un reinicio se lleva la memoria que acaba de nacer.
        if (this.relayAnswer.finish({ room, responder: member, message })) {
          this.persistFolder(room);
        }
        return;
      }

      case 'error':
        room.touch(channel.id, now);
        this.relayAnswer.fail({ room, responder: member.alias, message });
        return;

      case 'folder_put': {
        room.touch(channel.id, now);
        if (this.writeFolder.put({ room, member, channel, message })) this.persistFolder(room);
        return;
      }

      case 'folder_drop': {
        room.touch(channel.id, now);
        if (this.writeFolder.drop({ room, member, channel, message })) {
          this.persistFolder(room);
        }
        return;
      }

      case 'folder_get':
        room.touch(channel.id, now);
        this.writeFolder.get({ room, member, channel, message });
        return;
    }
  }

  disconnect(channelId: string): void {
    this.challenges.forget(channelId);
    this.leaveRoom.handle({ channelId });
    this.persistRooms();
  }

  sweep(): void {
    this.sweepStale.handle();
  }
}
