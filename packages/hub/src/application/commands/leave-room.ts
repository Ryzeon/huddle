import type { RoomRegistry } from '../state/room-registry.js';
import type { RoomNotifier } from '../state/room-notifier.js';
import type { AskTimeouts } from '../state/ask-timeouts.js';
import { ROOM_CLOSED_CODE } from './close-room.js';

export interface LeaveRoomCommand {
  channelId: string;
}

export interface LeaveRoomDeps {
  registry: RoomRegistry;
  notifier: RoomNotifier;
  timeouts: AskTimeouts;
  log: (message: string) => void;
}

export class LeaveRoomHandler {
  constructor(private readonly deps: LeaveRoomDeps) {}

  handle({ channelId }: LeaveRoomCommand): void {
    const { registry, notifier, timeouts, log } = this.deps;

    const room = registry.roomOf(channelId);
    registry.detach(channelId);
    if (!room) return;

    // Quien esperaba en la puerta y se cansó: no era miembro, así que no hay
    // roster que difundir ni mando que heredar. Solo hay que retirar su
    // solicitud, o el anfitrión seguiría viendo una petición fantasma.
    const waiting = room.removeWaiting(channelId);
    if (waiting) {
      notifier.toHost(room, { t: 'join_request_gone', id: waiting.id, reason: 'left' });
      log(`${waiting.alias} dejó de esperar en #${room.code}`);
      return;
    }

    const { member, abandoned, newHost } = room.leave(channelId);
    if (!member) return;

    for (const ask of abandoned) {
      notifier.toAsker(room, {
        t: 'error',
        id: ask.id,
        from: member.alias,
        reason: 'target_offline',
        detail: 'el agente se desconectó a mitad de la respuesta',
      });
      // En un `@all` puede quedar otro respondiendo: solo se cancela el
      // timeout cuando ya no falta nadie.
      if (ask.awaiting.size === 0) timeouts.cancel(ask.id);
    }

    if (newHost) {
      // El anfitrión se fue: hereda el más antiguo de los que quedan, y con el
      // mando hereda la puerta. Sin el backlog, quien ya estaba esperando lo
      // haría contra nadie hasta caducar.
      notifier.broadcast(room, { t: 'host_changed', host: newHost, reason: 'left' });
      notifier.sendPendingRequests(room, newHost);
      log(`${newHost} es ahora el anfitrión de #${room.code}`);
    }

    notifier.broadcastRoster(room);
    log(`salió ${member.alias} de #${room.code}`);

    // Sin nadie dentro no queda quien pueda abrir la puerta: dejar a alguien
    // esperando a una sala vacía sería tenerlo diez minutos para nada.
    if (room.isEmpty) {
      for (const guest of room.waitingList()) {
        const suyo = registry.channel(guest.channelId);
        suyo?.send({
          t: 'room_closed',
          reason: 'empty',
          detail: 'no queda nadie en la sala que pueda dejarte entrar',
        });
        suyo?.close(ROOM_CLOSED_CODE, 'room empty');
        room.removeWaiting(guest.channelId);
        registry.detach(guest.channelId);
      }
    }

    // Al salir el último, la sala se cierra. El historial ya está en disco.
    if (room.isEmpty) log(`#${room.code} ("${room.name}") se cerró: no queda nadie`);
    registry.dropIfExhausted(room);
  }
}
