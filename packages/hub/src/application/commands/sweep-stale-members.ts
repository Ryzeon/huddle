import type { ClockPort } from '../ports/member-channel.js';
import type { RoomRegistry } from '../state/room-registry.js';
import type { LeaveRoomHandler } from './leave-room.js';

export interface SweepStaleDeps {
  registry: RoomRegistry;
  leaveRoom: LeaveRoomHandler;
  clock: ClockPort;
  heartbeatTimeoutMs: number;
  log: (message: string) => void;
}

/**
 * Expulsa a los agentes que dejaron de latir.
 *
 * Un socket puede quedar medio abierto (portátil suspendido, wifi caído) sin
 * que llegue nunca el `close`. Sin este barrido, ese miembro seguiría en el
 * roster recibiendo preguntas que nadie va a responder.
 *
 * Reutiliza `LeaveRoomHandler` a propósito: salir por desconexión o por
 * silencio debe hacer exactamente lo mismo.
 */
export class SweepStaleMembersHandler {
  constructor(private readonly deps: SweepStaleDeps) {}

  handle(): void {
    const { registry, leaveRoom, clock, log } = this.deps;
    const cutoff = clock.now() - this.deps.heartbeatTimeoutMs;

    for (const room of registry.allRooms()) {
      for (const stale of room.staleMembers(cutoff)) {
        registry.channel(stale.channelId)?.close(4004, 'heartbeat timeout');
        leaveRoom.handle({ channelId: stale.channelId });
        log(`barrido ${stale.alias} de #${room.code} (sin latido)`);
      }
    }
  }
}
