import { PROTOCOL_VERSION, keyTail, normalizeAlias, type JoinMessage } from '@huddle/protocol';
import { normalizeRoomCode } from '../../domain/room-code.js';
import { decideIdentity } from '../../domain/identity.js';
import type {
  ClockPort,
  MemberChannelPort,
  SignatureVerifierPort,
} from '../ports/member-channel.js';
import type { RoomRegistry } from '../state/room-registry.js';
import type { RoomNotifier } from '../state/room-notifier.js';
import type { Challenges } from '../state/challenges.js';
import { verifiedKey } from './verify-identity.js';

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
}
