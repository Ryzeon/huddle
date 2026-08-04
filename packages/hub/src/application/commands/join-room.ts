import { PROTOCOL_VERSION, normalizeAlias, type JoinMessage } from '@huddle/protocol';
import { normalizeRoomCode } from '../../domain/room-code.js';
import type { ClockPort, MemberChannelPort } from '../ports/member-channel.js';
import type { RoomRegistry } from '../state/room-registry.js';
import type { RoomNotifier } from '../state/room-notifier.js';

export interface JoinRoomCommand {
  channel: MemberChannelPort;
  message: JoinMessage;
}

export interface JoinRoomDeps {
  registry: RoomRegistry;
  notifier: RoomNotifier;
  clock: ClockPort;
  log: (message: string) => void;
}

export class JoinRoomHandler {
  constructor(private readonly deps: JoinRoomDeps) {}

  handle({ channel, message }: JoinRoomCommand): void {
    if (message.v !== PROTOCOL_VERSION) {
      channel.send({
        t: 'error',
        id: '',
        reason: 'bad_request',
        detail: `versión de protocolo ${message.v}, el hub habla ${PROTOCOL_VERSION}`,
      });
      channel.close(4002, 'protocol mismatch');
      return;
    }

    const { registry, notifier, clock, log } = this.deps;
    const alias = normalizeAlias(message.alias);
    const now = clock.now();

    // El código ES la llave: si no existe la sala, no hay nada que abrir.
    const room = registry.roomByCode(normalizeRoomCode(message.room));
    if (!room) {
      channel.send({
        t: 'error',
        id: '',
        reason: 'bad_request',
        detail: `no existe ninguna sala con el código "${message.room}"`,
      });
      channel.close(4001, 'unknown room code');
      return;
    }

    const { replaced, becameHost, reclaimedHost } = room.join(
      {
        channelId: channel.id,
        alias,
        tag: message.tag,
        card: message.card,
        viewer: message.viewer,
        lastSeen: now,
        quotaRemaining: message.quotaRemaining,
      },
      now,
    );

    // Reconexión: cerramos el canal viejo para no dejar un miembro fantasma
    // ocupando sitio en el roster y recibiendo preguntas que nadie atenderá.
    if (replaced && replaced.channelId !== channel.id) {
      registry.channel(replaced.channelId)?.close(4003, 'replaced by new connection');
      registry.detach(replaced.channelId);
    }

    registry.attach(channel, room.code);

    channel.send({
      t: 'welcome',
      v: PROTOCOL_VERSION,
      room: room.code,
      roomName: room.name,
      you: alias,
      host: room.hostAlias ?? alias,
      members: room.roster(),
    });

    if (reclaimedHost) {
      notifier.broadcast(room, { t: 'host_changed', host: alias, reason: 'returned' });
    }

    if (becameHost) {
      notifier.broadcast(room, { t: 'host_changed', host: alias, reason: 'created' });
    }
    notifier.broadcastRoster(room);
    log(`entró ${alias} a #${room.code} (${message.card?.repo ?? 'sin repo'})`);
  }
}
