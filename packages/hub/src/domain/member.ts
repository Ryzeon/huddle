import { keyTail, type Alias, type CapabilityCard, type Member } from '@huddle/protocol';

export interface RoomMember {
  readonly channelId: string;
  readonly alias: Alias;
  readonly tag?: string;
  card?: CapabilityCard;
  readonly viewer?: boolean;
  /** La clave con la que firmó, si firmó. */
  readonly pubkey?: string;
  readonly verified?: boolean;
  readonly joinedAt: number;
  lastSeen: number;
  quotaRemaining: number | null;
  inFlight: number;
  askTokens: number;
  askTokensAt: number;
}

export function memberKey(alias: Alias, tag?: string): string {
  return tag ? `${alias}:${tag}` : alias;
}

export function toWireMember(member: RoomMember): Member {
  const wire: Member = {
    alias: member.alias,
    viewer: member.viewer,
    joinedAt: member.joinedAt,
    tag: member.tag,
    status: member.inFlight > 0 ? 'busy' : 'online',
    card: member.card,
    lastSeen: member.lastSeen,
    quotaRemaining: member.quotaRemaining,
  };
  // Al roster va la cola de la clave, nunca la clave entera: para comparar de
  // viva voz sobra, y publicarla completa no aporta nada.
  if (member.verified) wire.verified = true;
  if (member.pubkey) wire.key = keyTail(member.pubkey);
  return wire;
}
