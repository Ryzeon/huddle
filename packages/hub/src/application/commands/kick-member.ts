import { normalizeAlias, type Alias, type KickMessage } from '@huddle/protocol';
import type { Room } from '../../domain/room.js';
import type { MemberChannelPort } from '../ports/member-channel.js';
import type { RoomRegistry } from '../state/room-registry.js';

export interface KickMemberCommand {
  room: Room;
  requester: Alias;
  channel: MemberChannelPort;
  message: KickMessage;
}

export interface KickMemberDeps {
  registry: RoomRegistry;
  log: (message: string) => void;
}

/**
 * Expulsa a alguien de la sala. Solo el anfitrión.
 *
 * Echa **todos sus tags**: si alguien expone tres repositorios, expulsarlo
 * y que le quedaran dos conexiones dentro no sería expulsarlo.
 *
 * El cierre lleva código 4003, que el agente trata como terminal — así el
 * expulsado no reconecta en bucle.
 */
export class KickMemberHandler {
  constructor(private readonly deps: KickMemberDeps) {}

  handle({ room, requester, channel, message }: KickMemberCommand): void {
    if (!room.isHost(requester)) {
      channel.send({
        t: 'error',
        id: '',
        reason: 'denied_by_owner',
        detail: `solo el anfitrión (${room.hostAlias ?? '—'}) puede expulsar`,
      });
      return;
    }

    const target = normalizeAlias(message.alias);

    if (target === requester) {
      channel.send({
        t: 'error',
        id: '',
        reason: 'bad_request',
        detail: 'no puedes expulsarte a ti mismo; sal de la sala y ya',
      });
      return;
    }

    const channels = room.channelsOf(target);
    if (channels.length === 0) {
      channel.send({
        t: 'error',
        id: '',
        reason: 'target_offline',
        detail: `${target} no está en la sala`,
      });
      return;
    }

    for (const channelId of channels) {
      const victim = this.deps.registry.channel(channelId);
      victim?.send({
        t: 'room_closed',
        reason: 'kicked',
        detail: message.reason ?? `${requester} te expulsó de la sala`,
      });
      victim?.close(4003, 'kicked by host');
    }

    this.deps.log(`${requester} expulsó a ${target} de #${room.code}`);
  }
}
