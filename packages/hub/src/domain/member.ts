import type { Alias, CapabilityCard, Member } from '@huddle/protocol';

export interface RoomMember {
  readonly channelId: string;
  readonly alias: Alias;
  readonly tag?: string;
  card?: CapabilityCard;
  readonly viewer?: boolean;
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
  return {
    alias: member.alias,
    viewer: member.viewer,
    joinedAt: member.joinedAt,
    tag: member.tag,
    status: member.inFlight > 0 ? 'busy' : 'online',
    card: member.card,
    lastSeen: member.lastSeen,
    quotaRemaining: member.quotaRemaining,
  };
}
