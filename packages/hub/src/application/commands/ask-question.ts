import type { AskMessage } from '@huddle/protocol';
import type { Room } from '../../domain/room.js';
import type { RoomMember } from '../../domain/member.js';
import type { ClockPort, MemberChannelPort } from '../ports/member-channel.js';
import type { RoomNotifier } from '../state/room-notifier.js';
import type { AskTimeouts } from '../state/ask-timeouts.js';

export interface AskQuestionCommand {
  room: Room;
  asker: RoomMember;
  channel: MemberChannelPort;
  message: AskMessage;
}

export interface AskQuestionDeps {
  notifier: RoomNotifier;
  timeouts: AskTimeouts;
  clock: ClockPort;
  maxTtlSeconds: number;
  log: (message: string) => void;
}

export class AskQuestionHandler {
  constructor(private readonly deps: AskQuestionDeps) {}

  handle({ room, asker, channel, message }: AskQuestionCommand): void {
    const { notifier, timeouts, clock, log } = this.deps;
    const ttl = Math.min(message.ttl, this.deps.maxTtlSeconds);

    const outcome = room.openAsk(asker, message.id, message.to, message.q, clock.now());

    if (outcome.kind === 'rejected') {
      channel.send({ t: 'error', id: message.id, reason: outcome.reason, detail: outcome.detail });
      return;
    }

    timeouts.schedule(message.id, ttl * 1000, () => {
      for (const alias of room.expire(message.id)) {
        channel.send({
          t: 'error',
          id: message.id,
          from: alias,
          reason: 'timeout',
          detail: `sin respuesta en ${ttl}s`,
        });
      }
      notifier.broadcastRoster(room);
    });

    for (const target of outcome.targets) {
      notifier.toChannel(target.channelId, {
        t: 'request',
        id: message.id,
        from: asker.alias,
        q: message.q,
        ttl,
      });

      // La sala entera ve QUIÉN pregunta a quién, nunca el contenido: eso es
      // privado de quien preguntó. Basta para dibujarlo.
      notifier.broadcast(room, {
        t: 'activity',
        id: message.id,
        from: asker.alias,
        to: target.alias,
        phase: 'asking',
      });
    }

    notifier.broadcastRoster(room);
    log(`${asker.alias} → ${message.to} (${outcome.targets.length}): ${message.q.slice(0, 60)}`);
  }
}
