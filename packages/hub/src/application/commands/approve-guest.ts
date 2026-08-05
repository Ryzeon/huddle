import {
  keyTail,
  type Alias,
  type AdmitGuestMessage,
  type DenyGuestMessage,
} from '@huddle/protocol';
import { decideIdentity } from '../../domain/identity.js';
import type { Room } from '../../domain/room.js';
import type { ClockPort, MemberChannelPort } from '../ports/member-channel.js';
import type { RoomRegistry } from '../state/room-registry.js';
import type { RoomNotifier } from '../state/room-notifier.js';
import { enterRoom, IDENTITY_CODE } from './enter-room.js';

export interface ApproveGuestCommand {
  room: Room;
  requester: Alias;
  channel: MemberChannelPort;
  message: AdmitGuestMessage | DenyGuestMessage;
}

export interface ApproveGuestDeps {
  registry: RoomRegistry;
  notifier: RoomNotifier;
  clock: ClockPort;
  log: (message: string) => void;
}

/** Cierre por admisión: no te dejaron entrar, o la espera caducó. */
export const ADMISSION_CODE = 4008;

/**
 * El anfitrión decide quién pasa de la puerta al salón.
 *
 * Siempre por id de solicitud, nunca por alias: dos personas pueden pedir
 * entrar como `@ana` a la vez, y aprobar "a @ana" dejaría entrar a la que no
 * era sin que nadie pudiera notarlo.
 */
export class ApproveGuestHandler {
  constructor(private readonly deps: ApproveGuestDeps) {}

  handle({ room, requester, channel, message }: ApproveGuestCommand): void {
    const { registry, notifier, clock, log } = this.deps;

    if (!room.isHost(requester)) {
      channel.send({
        t: 'error',
        id: message.id,
        reason: 'denied_by_owner',
        detail: `solo el anfitrión (${room.hostAlias ?? '—'}) decide quién entra`,
      });
      return;
    }

    if (message.t === 'deny') {
      const guest = room.admission.deny(message.id);
      if (!guest) return this.gone(channel, message.id);

      const suyo = registry.channel(guest.channelId);
      suyo?.send({
        t: 'error',
        id: '',
        reason: 'denied_by_owner',
        detail: message.reason ?? `${requester} no te dejó entrar`,
      });
      suyo?.close(ADMISSION_CODE, 'denied by host');
      registry.detach(guest.channelId);

      notifier.toHost(room, { t: 'join_request_gone', id: message.id, reason: 'resolved' });
      log(`${requester} rechazó a ${guest.alias} en #${room.code}`);
      return;
    }

    const now = clock.now();
    const pending = room.waitingBy(message.id);
    if (!pending) return this.gone(channel, message.id);

    const suyo = registry.channel(pending.channelId);
    if (!suyo) {
      // Se cansó de esperar y cerró antes de que le abrieran la puerta.
      room.admission.deny(message.id);
      notifier.toHost(room, { t: 'join_request_gone', id: message.id, reason: 'left' });
      return;
    }

    // El alias pudo atarse mientras esperaba: abrir la puerta no es saltarse la
    // firma de quien ya está dentro.
    const decision = decideIdentity(room.keyOf(pending.alias), pending.key);
    if (decision.kind === 'impostor' || decision.kind === 'squatter') {
      room.admission.deny(message.id);
      suyo.send({
        t: 'error',
        id: '',
        reason: 'identity_mismatch',
        detail:
          `${pending.alias} está firmado en esta sala por la clave …${keyTail(decision.bound)}. ` +
          'Firma con esa clave o entra con otro alias.',
      });
      suyo.close(IDENTITY_CODE, 'alias bound to another key');
      registry.detach(pending.channelId);
      notifier.toHost(room, { t: 'join_request_gone', id: message.id, reason: 'resolved' });
      log(`${pending.alias} no entró en #${room.code}: el alias ya es de otra clave`);
      return;
    }

    const guest = room.admission.approve(message.id, message.remember !== false, now);
    if (!guest) return this.gone(channel, message.id);

    notifier.toHost(room, { t: 'join_request_gone', id: message.id, reason: 'resolved' });
    enterRoom(
      { registry, notifier },
      {
        room,
        channel: suyo,
        alias: guest.alias,
        tag: guest.tag,
        card: guest.card,
        viewer: guest.viewer,
        identity: decision,
        quotaRemaining: null,
        now,
      },
    );

    log(`${requester} dejó entrar a ${guest.alias} en #${room.code}`);
  }

  /** La solicitud ya no existe: caducó, se fue, o alguien llegó antes. */
  private gone(channel: MemberChannelPort, id: string): void {
    channel.send({
      t: 'error',
      id,
      reason: 'bad_request',
      detail: 'esa solicitud ya no está esperando',
    });
  }
}
