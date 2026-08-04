import type { RoomRegistry } from '../state/room-registry.js';
import type { RoomNotifier } from '../state/room-notifier.js';
import type { AskTimeouts } from '../state/ask-timeouts.js';

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
      // El anfitrión se fue: hereda el más antiguo de los que quedan.
      notifier.broadcast(room, { t: 'host_changed', host: newHost, reason: 'left' });
      log(`${newHost} es ahora el anfitrión de #${room.code}`);
    }

    notifier.broadcastRoster(room);
    log(`salió ${member.alias} de #${room.code}`);

    // Al salir el último, la sala se cierra. El historial ya está en disco.
    if (room.isEmpty) log(`#${room.code} ("${room.name}") se cerró: no queda nadie`);
    registry.dropIfExhausted(room);
  }
}
