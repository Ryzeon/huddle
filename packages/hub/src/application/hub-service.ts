import type { ClientMessage } from '@huddle/protocol';
import type { TranscriptEntry } from '../domain/room.js';
import type { BucketPolicy } from '../domain/rate-limit.js';
import type {
  ClockPort,
  MemberChannelPort,
  RoomStorePort,
  TimerPort,
  TranscriptStorePort,
} from './ports/member-channel.js';
import { RoomRegistry } from './state/room-registry.js';
import { RoomNotifier } from './state/room-notifier.js';
import { AskTimeouts } from './state/ask-timeouts.js';
import { JoinRoomHandler } from './commands/join-room.js';
import { CreateRoomHandler } from './commands/create-room.js';
import { KickMemberHandler } from './commands/kick-member.js';
import { generateRoomCode, normalizeRoomCode } from '../domain/room-code.js';
import { AskQuestionHandler } from './commands/ask-question.js';
import { RelayAnswerHandler } from './commands/relay-answer.js';
import { LeaveRoomHandler } from './commands/leave-room.js';
import { SweepStaleMembersHandler } from './commands/sweep-stale-members.js';
import { RoomQueries, type HubStats } from './queries/room-queries.js';

export interface HubConfig {
  askPolicy: BucketPolicy;
  retentionMs: number;
  maxTtlSeconds: number;
  heartbeatTimeoutMs: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_HUB_CONFIG: HubConfig = {
  askPolicy: { burst: 5, refillMs: 10_000 },
  retentionMs: 30 * DAY_MS,
  maxTtlSeconds: 300,
  heartbeatTimeoutMs: 45_000,
};

export interface HubDeps {
  clock: ClockPort;
  timers: TimerPort;
  transcripts: TranscriptStorePort;
  rooms?: RoomStorePort;
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
  private readonly askQuestion: AskQuestionHandler;
  private readonly relayAnswer: RelayAnswerHandler;
  private readonly leaveRoom: LeaveRoomHandler;
  private readonly sweepStale: SweepStaleMembersHandler;

  private readonly clock: ClockPort;
  private readonly transcripts: TranscriptStorePort;
  private readonly roomStore?: RoomStorePort;
  private readonly retentionMs: number;
  private readonly log: (message: string) => void;

  constructor(deps: HubDeps, config: HubConfig = DEFAULT_HUB_CONFIG) {
    const log = deps.log ?? (() => undefined);

    this.clock = deps.clock;
    this.transcripts = deps.transcripts;
    this.roomStore = deps.rooms;
    this.retentionMs = config.retentionMs;
    this.log = log;
    this.registry = new RoomRegistry(config.askPolicy);
    this.notifier = new RoomNotifier(this.registry);
    this.queries = new RoomQueries(this.registry);

    const timeouts = new AskTimeouts(deps.timers);
    const shared = { registry: this.registry, notifier: this.notifier, timeouts, log };

    const generateCode = deps.generateCode ?? generateRoomCode;
    this.createRoom = new CreateRoomHandler({
      registry: this.registry,
      notifier: this.notifier,
      clock: deps.clock,
      generateCode,
      log,
    });
    this.joinRoom = new JoinRoomHandler({ ...shared, clock: deps.clock });
    this.kickMember = new KickMemberHandler({ registry: this.registry, log });
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
    });
    this.leaveRoom = new LeaveRoomHandler({ ...shared, notifier: this.notifier });
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
    this.log(`${records.length} sala(s) recuperadas del disco`);
    this.purgeExpired();
  }

  purgeExpired(): void {
    const cutoff = this.clock.now() - this.retentionMs;
    let closed = 0;

    for (const room of this.registry.allRooms()) {
      const remaining = this.transcripts.purge(room.code, cutoff);
      room.replaceTranscript(this.transcripts.read(room.code));

      if (remaining === 0 && room.isEmpty && room.createdAt < cutoff) {
        this.registry.forget(room.code);
        closed += 1;
      }
    }

    if (closed > 0) this.log(`${closed} sala(s) cerradas por antigüedad`);
    this.persistRooms();
  }

  private persistRooms(): void {
    this.roomStore?.writeAll(this.registry.snapshot());
  }

  transcriptOf(roomCode: string): readonly TranscriptEntry[] {
    const code = normalizeRoomCode(roomCode);
    const live = this.queries.transcript(code);
    return live.length > 0 ? live : this.transcripts.read(code);
  }

  stats(): HubStats {
    return this.queries.stats();
  }

  handle(channel: MemberChannelPort, message: ClientMessage): void {
    if (message.t === 'create') {
      this.createRoom.handle({ channel, message });
      this.persistRooms();
      return;
    }
    if (message.t === 'join') {
      this.joinRoom.handle({ channel, message });
      return;
    }

    const room = this.registry.roomOf(channel.id);
    const member = room?.find(channel.id);
    if (!room || !member) {
      channel.send({
        t: 'error',
        id: '',
        reason: 'bad_request',
        detail: 'hay que mandar `join` primero',
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
        return;

      // El resto viene del que responde y vuelve a quien preguntó.
      case 'chunk':
      case 'trace':
        room.touch(channel.id, now);
        this.relayAnswer.relayProgress({ room, responder: member.alias, message });
        return;

      case 'result':
        room.touch(channel.id, now);
        this.relayAnswer.finish({ room, responder: member.alias, message });
        return;

      case 'error':
        room.touch(channel.id, now);
        this.relayAnswer.fail({ room, responder: member.alias, message });
        return;
    }
  }

  disconnect(channelId: string): void {
    this.leaveRoom.handle({ channelId });
    this.persistRooms();
  }

  sweep(): void {
    this.sweepStale.handle();
  }
}
