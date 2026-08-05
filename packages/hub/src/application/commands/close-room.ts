import type { Alias, CloseRoomMessage } from '@huddle/protocol';
import type { Room } from '../../domain/room.js';
import type {
  FolderStorePort,
  MemberChannelPort,
  TranscriptStorePort,
} from '../ports/member-channel.js';
import type { RoomRegistry } from '../state/room-registry.js';

export interface CloseRoomCommand {
  room: Room;
  requester: Alias;
  channel: MemberChannelPort;
  message: CloseRoomMessage;
}

export interface CloseRoomDeps {
  registry: RoomRegistry;
  transcripts: TranscriptStorePort;
  folders?: FolderStorePort;
  log: (message: string) => void;
}

/** Código de cierre: los agentes lo tratan como terminal y no reconectan. */
export const ROOM_CLOSED_CODE = 4004;

/**
 * Cierra la sala del todo: echa a todos, la borra del registro y purga su
 * historial. Solo el anfitrión.
 *
 * Es lo único que hace desaparecer una sala antes de que venza su retención.
 * Sin esto, una sala vacía se queda dormida treinta días y su código sigue
 * sirviendo para entrar.
 */
export class CloseRoomHandler {
  constructor(private readonly deps: CloseRoomDeps) {}

  handle({ room, requester, channel, message }: CloseRoomCommand): void {
    if (!room.isHost(requester)) {
      channel.send({
        t: 'error',
        id: '',
        reason: 'denied_by_owner',
        detail: `solo el anfitrión (${room.hostAlias ?? '—'}) puede cerrar la sala`,
      });
      return;
    }

    const detail = message.reason ?? `${requester} cerró la sala`;

    // Se avisa a todos antes de cortar: quien esté mirando merece saber por qué
    // se le acaba de cerrar la puerta.
    for (const member of room.members) {
      const suyo = this.deps.registry.channel(member.channelId);
      suyo?.send({ t: 'room_closed', reason: 'closed_by_host', detail });
      suyo?.close(ROOM_CLOSED_CODE, 'room closed by host');
    }

    // El historial y la carpeta se van con la sala. Cerrar y dejarlos sería
    // cerrar a medias, y el código volvería a funcionar tras un reinicio.
    this.deps.transcripts.purge(room.code, Number.POSITIVE_INFINITY);
    this.deps.folders?.purge(room.code);
    this.deps.registry.forget(room.code);

    this.deps.log(`sala ${room.code} cerrada por ${requester}`);
  }
}
