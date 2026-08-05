import {
  PROTOCOL_VERSION,
  keyTail,
  newId,
  normalizeAlias,
  type JoinMessage,
} from '@huddle/protocol';
import { normalizeRoomCode } from '../../domain/room-code.js';
import { decideIdentity } from '../../domain/identity.js';
import type { Room } from '../../domain/room.js';
import type {
  ClockPort,
  MemberChannelPort,
  SignatureVerifierPort,
  TimerPort,
} from '../ports/member-channel.js';
import type { RoomRegistry } from '../state/room-registry.js';
import type { RoomNotifier } from '../state/room-notifier.js';
import type { Challenges } from '../state/challenges.js';
import { verifiedKey } from './verify-identity.js';
import { ADMISSION_CODE } from './approve-guest.js';

export interface JoinRoomCommand {
  channel: MemberChannelPort;
  message: JoinMessage;
}

export interface JoinRoomDeps {
  registry: RoomRegistry;
  notifier: RoomNotifier;
  clock: ClockPort;
  challenges: Challenges;
  verifier: SignatureVerifierPort;
  timers: TimerPort;
  approvalTimeoutMs: number;
  log: (message: string) => void;
}

/** Cierre por identidad: el alias es de otra clave, o te lo acaban de reclamar. */
export const IDENTITY_CODE = 4007;

export class JoinRoomHandler {
  constructor(private readonly deps: JoinRoomDeps) {}

  /** Devuelve `true` si el join ató una clave nueva y hay que persistir. */
  handle({ channel, message }: JoinRoomCommand): boolean {
    if (message.v !== PROTOCOL_VERSION) {
      channel.send({
        t: 'error',
        id: '',
        reason: 'bad_request',
        detail: `versión de protocolo ${message.v}, el hub habla ${PROTOCOL_VERSION}`,
      });
      channel.close(4002, 'protocol mismatch');
      return false;
    }

    const { registry, notifier, clock, challenges, verifier, log } = this.deps;
    const alias = normalizeAlias(message.alias);
    const now = clock.now();
    const code = normalizeRoomCode(message.room);

    // El código ES la llave: si no existe la sala, no hay nada que abrir.
    const room = registry.roomByCode(code);
    if (!room) {
      challenges.forget(channel.id);
      channel.send({
        t: 'error',
        id: '',
        reason: 'bad_request',
        detail: `no existe ninguna sala con el código "${message.room}"`,
      });
      channel.close(4001, 'unknown room code');
      return false;
    }

    const offered = verifiedKey(
      { challenges, verifier },
      {
        channelId: channel.id,
        proof: message.proof,
        context: {
          kind: 'join',
          room: room.code,
          alias,
          tag: message.tag,
          viewer: message.viewer,
        },
      },
    );

    const decision = decideIdentity(room.keyOf(alias), offered);

    if (decision.kind === 'impostor') {
      channel.send({
        t: 'error',
        id: '',
        reason: 'identity_mismatch',
        detail:
          `${alias} ya está firmado en esta sala por la clave …${keyTail(decision.bound)}, ` +
          `y tú firmas con …${keyTail(decision.offered)}. Entra con otro alias, ` +
          'o usa la misma clave que la primera vez.',
      });
      channel.close(IDENTITY_CODE, 'alias bound to another key');
      return false;
    }

    if (decision.kind === 'squatter') {
      channel.send({
        t: 'error',
        id: '',
        reason: 'identity_mismatch',
        detail:
          `${alias} está firmado en esta sala por la clave …${keyTail(decision.bound)}. ` +
          'Firma con esa clave o entra con otro alias.',
      });
      channel.close(IDENTITY_CODE, 'alias requires a signature');
      return false;
    }

    // Quien tenía el alias sin firmarlo sale antes de que entre el que sí lo
    // firma: dos @ana en el roster, una de ellas okupa, no es un roster.
    if (decision.kind === 'bind') {
      room.bindKey(alias, decision.pubkey);
      for (const channelId of room.unsignedChannelsOf(alias)) {
        const okupa = registry.channel(channelId);
        okupa?.send({
          t: 'room_closed',
          reason: 'identity_taken',
          detail: `${alias} lo reclamó quien tiene su clave`,
        });
        okupa?.close(IDENTITY_CODE, 'alias claimed by its key');
        room.leave(channelId);
        registry.detach(channelId);
      }
    }

    const verified = decision.kind === 'bind' || decision.kind === 'known';

    // La puerta. Quien espera no es miembro: ni sale en el roster, ni recibe
    // preguntas, ni ve el historial, ni cuenta para que la sala esté vacía.
    const admission = room.decideAdmission(offered, alias);

    if (admission.kind === 'full') {
      channel.send({
        t: 'error',
        id: '',
        reason: 'denied_by_owner',
        detail: 'hay demasiada gente esperando en la puerta; prueba en un rato',
      });
      channel.close(ADMISSION_CODE, 'waiting room full');
      return decision.kind === 'bind';
    }

    if (admission.kind === 'wait') {
      this.wait(room, channel, message, alias, offered);
      return decision.kind === 'bind';
    }

    const { replaced, becameHost, reclaimedHost } = room.join(
      {
        channelId: channel.id,
        alias,
        tag: message.tag,
        card: message.card,
        viewer: message.viewer,
        pubkey: offered,
        verified,
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
      verified,
    });

    if (reclaimedHost) {
      notifier.broadcast(room, { t: 'host_changed', host: alias, reason: 'returned' });
    }

    if (becameHost) {
      notifier.broadcast(room, { t: 'host_changed', host: alias, reason: 'created' });
    }
    notifier.broadcastRoster(room);
    log(`entró ${alias} a #${room.code} (${message.card?.repo ?? 'sin repo'})`);

    return decision.kind === 'bind';
  }

  /**
   * Deja a alguien en la puerta y avisa al anfitrión.
   *
   * El canal se registra en el registro pero NO en la sala: hace falta para
   * poder contestarle y para saber, al desconectar, de qué sala se cayó.
   */
  private wait(
    room: Room,
    channel: MemberChannelPort,
    message: JoinMessage,
    alias: string,
    key: string | undefined,
  ): void {
    const { registry, notifier, clock, timers, approvalTimeoutMs, log } = this.deps;
    const now = clock.now();
    const id = newId();

    room.addWaiting({
      id,
      channelId: channel.id,
      alias,
      tag: message.tag,
      key: key ?? '',
      card: message.card,
      viewer: message.viewer,
      at: now,
    });
    registry.attach(channel, room.code);

    channel.send({
      t: 'waiting_approval',
      id,
      room: room.code,
      roomName: room.name,
      you: alias,
      host: room.hostAlias ?? '@?',
      key: key ? keyTail(key) : '',
    });

    const knownAlias = key ? room.admission.aliasOwner(key) : undefined;
    notifier.toHost(room, {
      t: 'join_request',
      id,
      alias,
      tag: message.tag,
      key: key ? keyTail(key) : '',
      card: message.card,
      at: now,
      ...(knownAlias && { knownAlias }),
    });

    // Nadie se queda en la puerta para siempre: si el anfitrión no está, la
    // espera caduca y se dice, en vez de dejar el socket colgado.
    timers.schedule(approvalTimeoutMs, () => {
      const guest = room.waitingBy(id);
      if (!guest || guest.channelId !== channel.id) return;

      room.removeWaiting(channel.id);
      registry.detach(channel.id);
      channel.send({
        t: 'error',
        id: '',
        reason: 'denied_by_owner',
        detail: 'el anfitrión no respondió a tiempo; vuelve a intentarlo',
      });
      channel.close(ADMISSION_CODE, 'approval timed out');
      notifier.toHost(room, { t: 'join_request_gone', id, reason: 'expired' });
    });

    log(`${alias} espera aprobación en #${room.code}`);
  }
}
