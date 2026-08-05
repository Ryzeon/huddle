import { PROTOCOL_VERSION, type Alias, type CapabilityCard } from '@huddle/protocol';
import type { IdentityDecision } from '../../domain/identity.js';
import type { Room } from '../../domain/room.js';
import type { MemberChannelPort } from '../ports/member-channel.js';
import type { RoomRegistry } from '../state/room-registry.js';
import type { RoomNotifier } from '../state/room-notifier.js';

/** Cierre por identidad: el alias es de otra clave, o te lo acaban de reclamar. */
export const IDENTITY_CODE = 4007;

/** Cierre por reconexión: otro canal entró con tu mismo alias y tag. */
export const REPLACED_CODE = 4003;

/** Lo que queda de `decideIdentity` cuando ya se ha descartado el rechazo. */
export type AdmittedIdentity = Extract<
  IdentityDecision,
  { kind: 'anonymous' | 'bind' | 'known' }
>;

export interface EnterRoomDeps {
  registry: RoomRegistry;
  notifier: RoomNotifier;
}

export interface EnterRoomCommand {
  room: Room;
  channel: MemberChannelPort;
  alias: Alias;
  tag?: string;
  card?: CapabilityCard;
  viewer?: boolean;
  identity: AdmittedIdentity;
  quotaRemaining: number | null;
  now: number;
}

export interface EnterRoomOutcome {
  verified: boolean;
  /** Se escribió un vínculo alias→clave que hay que persistir. */
  bound: boolean;
}

/**
 * Meter a alguien en la sala. Único sitio donde se ata una clave y donde se
 * desaloja al que ocupaba el alias, y corre DESPUÉS de decidir la admisión:
 * atar o desalojar por alguien que se queda en la puerta le quema el nombre a
 * su dueño sin que nadie haya entrado.
 */
export function enterRoom(
  { registry, notifier }: EnterRoomDeps,
  { room, channel, alias, tag, card, viewer, identity, quotaRemaining, now }: EnterRoomCommand,
): EnterRoomOutcome {
  const bound = identity.kind === 'bind' && room.bindKey(alias, identity.pubkey);
  const verified = identity.kind === 'known' || bound;
  const promoted = bound ? evictSquatters(room, registry, alias, channel.id) : undefined;
  const pubkey = identity.kind === 'anonymous' ? undefined : identity.pubkey;

  const { replaced, becameHost, reclaimedHost } = room.join(
    {
      channelId: channel.id,
      alias,
      tag,
      card,
      viewer,
      // La cola de clave del roster dice "este alias es de esta clave": sin vínculo no hay nada que enseñar.
      pubkey: verified ? pubkey : undefined,
      verified,
      lastSeen: now,
      quotaRemaining,
    },
    now,
  );

  // Reconexión: cerramos el canal viejo para no dejar un miembro fantasma
  // ocupando sitio en el roster y recibiendo preguntas que nadie atenderá.
  if (replaced && replaced.channelId !== channel.id) {
    registry.channel(replaced.channelId)?.close(REPLACED_CODE, 'replaced by new connection');
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

  if (becameHost || reclaimedHost) {
    notifier.broadcast(room, {
      t: 'host_changed',
      host: alias,
      reason: reclaimedHost ? 'returned' : 'created',
    });
  } else if (promoted && room.hostAlias === promoted) {
    notifier.broadcast(room, { t: 'host_changed', host: promoted, reason: 'left' });
    notifier.sendPendingRequests(room, promoted);
  }

  // El backlog va por ser anfitrión, no por acabar de serlo: quien recarga sin
  // haber perdido el mando vuelve con la lista vacía, y nadie más puede abrir.
  if (room.isHost(alias)) notifier.sendPendingRequests(room, alias);

  notifier.broadcastRoster(room);
  return { verified, bound };
}

/**
 * Echa a quien ocupaba el alias sin haberlo firmado. Devuelve el anfitrión
 * nuevo si el okupa era el anfitrión.
 */
function evictSquatters(
  room: Room,
  registry: RoomRegistry,
  alias: Alias,
  exclude: string,
): Alias | undefined {
  let promoted: Alias | undefined;

  for (const channelId of room.unsignedChannelsOf(alias)) {
    if (channelId === exclude) continue;
    const okupa = registry.channel(channelId);
    okupa?.send({
      t: 'room_closed',
      reason: 'identity_taken',
      detail: `${alias} lo reclamó quien tiene su clave`,
    });
    okupa?.close(IDENTITY_CODE, 'alias claimed by its key');
    const { newHost } = room.leave(channelId);
    if (newHost) promoted = newHost;
    registry.detach(channelId);
  }

  return promoted;
}
