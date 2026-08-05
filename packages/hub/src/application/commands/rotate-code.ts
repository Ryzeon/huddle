import type { Alias, RotateCodeMessage } from '@huddle/protocol';
import type { Room } from '../../domain/room.js';
import type {
  FolderStorePort,
  MemberChannelPort,
  TranscriptStorePort,
} from '../ports/member-channel.js';
import type { RoomRegistry } from '../state/room-registry.js';
import type { RoomNotifier } from '../state/room-notifier.js';
import type { AskTimeouts } from '../state/ask-timeouts.js';
import type { LeaveRoomHandler } from './leave-room.js';

export interface RotateCodeCommand {
  room: Room;
  requester: Alias;
  channel: MemberChannelPort;
  message: RotateCodeMessage;
}

export interface RotateCodeDeps {
  registry: RoomRegistry;
  notifier: RoomNotifier;
  timeouts: AskTimeouts;
  transcripts: TranscriptStorePort;
  folders?: FolderStorePort;
  leaveRoom: LeaveRoomHandler;
  generateCode: () => string;
  log: (message: string) => void;
}

/** Cierre por rotación: reconectar con el código viejo no llevaría a ningún lado. */
export const ROOM_ROTATED_CODE = 4006;

/**
 * Cambia el código de la sala sin recrearla. Solo el anfitrión.
 *
 * La sala sobrevive entera —dueño, anfitrión, historial— y quien no sea el
 * anfitrión se queda fuera hasta que le pasen el código nuevo. Es la respuesta
 * a un código filtrado sin perder lo que hay dentro.
 */
export class RotateCodeHandler {
  constructor(private readonly deps: RotateCodeDeps) {}

  handle({ room, requester, channel, message }: RotateCodeCommand): void {
    const { registry, notifier, timeouts, transcripts, folders, leaveRoom, log } = this.deps;

    if (!room.isHost(requester)) {
      channel.send({
        t: 'error',
        id: message.id,
        reason: 'denied_by_owner',
        detail: `solo el anfitrión (${room.hostAlias ?? '—'}) puede cambiar el código`,
      });
      return;
    }

    const previous = room.code;
    const next = registry.freeCode(this.deps.generateCode);

    // El historial se mueve ANTES de reindexar: si fallara después, el código
    // viejo seguiría sirviendo el transcript por el camino del store.
    if (!transcripts.rename(previous, next)) {
      channel.send({
        t: 'error',
        id: message.id,
        reason: 'bad_request',
        detail: 'no se pudo mover el historial de la sala; el código no ha cambiado',
      });
      return;
    }

    // La carpeta va detrás del historial y por el mismo motivo: si se quedara
    // bajo el código viejo, la sala sobreviviría a la rotación sin lo que el
    // equipo tenía escrito. Al fallar se devuelve el historial a su sitio,
    // porque quedarse a medias es peor que no rotar.
    if (folders && !folders.rename(previous, next)) {
      transcripts.rename(next, previous);
      channel.send({
        t: 'error',
        id: message.id,
        reason: 'bad_request',
        detail: 'no se pudo mover la carpeta de la sala; el código no ha cambiado',
      });
      return;
    }

    // Quien iba a responder está a punto de quedarse fuera: mejor un fallo
    // inmediato que un timeout de dos minutos contra nadie.
    for (const ask of room.expireAll()) {
      timeouts.cancel(ask.id);
      for (const channelId of room.channelsOf(ask.from)) {
        notifier.toChannel(channelId, {
          t: 'error',
          id: ask.id,
          reason: 'target_offline',
          detail: 'el código de la sala cambió a mitad de la pregunta',
        });
      }
    }

    const echados = room.members.filter((member) => member.alias !== requester);

    registry.recode(room, next);

    for (const channelId of room.channelsOf(requester)) {
      notifier.toChannel(channelId, {
        t: 'room_code',
        id: message.id,
        room: next,
        previous,
        by: requester,
      });
    }

    // Los que esperaban lo hacían por el código viejo. Se les echa igual: los
    // aprobados vuelven directos con el nuevo, sin pasar otra vez por la puerta.
    for (const guest of room.waitingList()) {
      const suyo = registry.channel(guest.channelId);
      suyo?.send({
        t: 'room_closed',
        reason: 'code_rotated',
        detail: message.reason ?? `${requester} cambió el código de la sala`,
      });
      suyo?.close(ROOM_ROTATED_CODE, 'room code rotated');
      room.removeWaiting(guest.channelId);
      registry.detach(guest.channelId);
      notifier.toHost(room, { t: 'join_request_gone', id: guest.id, reason: 'room_closed' });
    }

    for (const member of echados) {
      const suyo = registry.channel(member.channelId);
      suyo?.send({
        t: 'room_closed',
        reason: 'code_rotated',
        detail: message.reason ?? `${requester} cambió el código de la sala`,
      });
      suyo?.close(ROOM_ROTATED_CODE, 'room code rotated');
      leaveRoom.handle({ channelId: member.channelId });
    }

    log(`${requester} cambió el código de #${previous} a #${next}`);
  }
}
