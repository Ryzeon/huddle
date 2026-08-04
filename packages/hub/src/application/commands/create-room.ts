import { PROTOCOL_VERSION, normalizeAlias, type CreateRoomMessage } from '@huddle/protocol';
import type { ClockPort, MemberChannelPort } from '../ports/member-channel.js';
import type { RoomRegistry } from '../state/room-registry.js';
import type { RoomNotifier } from '../state/room-notifier.js';

export interface CreateRoomCommand {
  channel: MemberChannelPort;
  message: CreateRoomMessage;
}

export interface CreateRoomDeps {
  registry: RoomRegistry;
  notifier: RoomNotifier;
  clock: ClockPort;
  generateCode: () => string;
  log: (message: string) => void;
}

const MAX_NAME_LENGTH = 64;

/**
 * Crea una sala y mete dentro a quien la creó, que queda como anfitrión.
 *
 * El código generado **sustituye al token compartido**: es la única llave, así
 * que compartirlo es exactamente compartir el acceso.
 */
export class CreateRoomHandler {
  constructor(private readonly deps: CreateRoomDeps) {}

  handle({ channel, message }: CreateRoomCommand): void {
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

    const name = message.name.trim().slice(0, MAX_NAME_LENGTH);
    if (!name) {
      channel.send({
        t: 'error',
        id: '',
        reason: 'bad_request',
        detail: 'la sala necesita un nombre',
      });
      return;
    }

    const { registry, notifier, clock, log } = this.deps;
    const alias = normalizeAlias(message.alias);
    const room = registry.createRoom(name, this.deps.generateCode, clock.now());

    room.join(
      {
        channelId: channel.id,
        alias,
        tag: message.tag,
        card: message.card,
        lastSeen: clock.now(),
        quotaRemaining: message.quotaRemaining,
      },
      clock.now(),
    );
    registry.attach(channel, room.code);

    channel.send({
      t: 'welcome',
      v: PROTOCOL_VERSION,
      room: room.code,
      roomName: room.name,
      you: alias,
      host: alias,
      members: room.roster(),
    });
    notifier.broadcast(room, { t: 'host_changed', host: alias, reason: 'created' });

    log(`${alias} creó "${name}" → código ${room.code}`);
  }
}
