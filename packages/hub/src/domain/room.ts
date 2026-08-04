import type { Alias, Member, SourceRef, Target } from '@huddle/protocol';
import { memberKey, toWireMember, type RoomMember } from './member.js';
import { consume, newBucket, type BucketPolicy } from './rate-limit.js';
import { resolveAuto, resolveTargets } from './routing.js';

export interface PendingAsk {
  readonly id: string;
  readonly from: Alias;
  readonly question: string;
  readonly awaiting: Set<Alias>;
  readonly startedAt: number;
}

export interface TranscriptEntry {
  id: string;
  from: Alias;
  to: Alias;
  question: string;
  answer: string;
  sources: SourceRef[];
  confidence: string;
  sha?: string;
  branch?: string;
  elapsedMs: number;
  cached: boolean;
  at: number;
}

export type AskOutcome =
  | { kind: 'dispatch'; targets: RoomMember[] }
  | { kind: 'rejected'; reason: 'rate_limited' | 'target_offline'; detail: string };

const TRANSCRIPT_LIMIT = 500;

export class Room {
  readonly code: string;
  readonly name: string;
  readonly createdAt: number;
  private host?: Alias;

  /**
   * Quien creó la sala. El anfitrión puede cambiar de manos mientras no está,
   * pero al volver lo recupera: la sala es suya, no de quien pasaba por ahí.
   */
  private owner?: Alias;
  private readonly membersByKey = new Map<string, RoomMember>();
  private readonly pendingById = new Map<string, PendingAsk>();
  private readonly entries: TranscriptEntry[] = [];
  private readonly askPolicy: BucketPolicy;

  /**
   * `createdAt` es obligatorio a propósito: llamar a `Date.now()` aquí dentro
   * sería un reloj escondido en el dominio, y la retención dejaría de poder
   * probarse moviendo el tiempo a mano.
   */
  constructor(code: string, name: string, askPolicy: BucketPolicy, createdAt: number) {
    this.code = code;
    this.name = name;
    this.askPolicy = askPolicy;
    this.createdAt = createdAt;
  }

  replaceTranscript(entries: TranscriptEntry[]): void {
    this.entries.length = 0;
    this.entries.push(...entries);
  }

  get hostAlias(): Alias | undefined {
    return this.host;
  }

  get ownerAlias(): Alias | undefined {
    return this.owner;
  }

  /** Se usa al restaurar del disco, donde el dueño ya estaba decidido. */
  restoreOwner(alias: Alias): void {
    this.owner = alias;
  }

  isHost(alias: Alias): boolean {
    return this.host === alias;
  }

  private oldestMember(excluding?: Alias): Alias | undefined {
    let oldest: RoomMember | undefined;
    for (const member of this.members) {
      // Un observador no puede heredar el mando: no responde ni expulsa.
      if (member.alias === excluding || member.viewer) continue;
      if (!oldest || member.joinedAt < oldest.joinedAt) oldest = member;
    }
    return oldest?.alias;
  }

  promoteOldest(excluding?: Alias): Alias | undefined {
    this.host = this.oldestMember(excluding);
    return this.host;
  }

  get members(): RoomMember[] {
    return [...this.membersByKey.values()];
  }

  get isEmpty(): boolean {
    return this.membersByKey.size === 0;
  }

  get transcript(): readonly TranscriptEntry[] {
    return this.entries;
  }

  join(
    member: Omit<RoomMember, 'inFlight' | 'askTokens' | 'askTokensAt' | 'joinedAt'>,
    now: number,
  ): { replaced?: RoomMember; becameHost: boolean; reclaimedHost: boolean } {
    const key = memberKey(member.alias, member.tag);
    const previous = this.membersByKey.get(key);

    const bucket = newBucket(this.askPolicy, now);
    this.membersByKey.set(key, {
      ...member,
      // Una reconexión conserva su antigüedad: perderla te mandaría al final
      // de la línea de sucesión por un corte de wifi.
      joinedAt: previous?.joinedAt ?? now,
      inFlight: 0,
      askTokens: bucket.tokens,
      askTokensAt: bucket.updatedAt,
    });

    // Sala recién creada o que se quedó sin anfitrión: manda el que llega,
    // salvo que solo esté mirando.
    const becameHost = this.host === undefined && !member.viewer;
    if (becameHost) this.host = member.alias;
    if (this.owner === undefined && becameHost) this.owner = member.alias;

    // El dueño vuelve: recupera el mando de quien se lo estaba guardando. No
    // cuenta una reconexión de quien ya lo tenía, que no es volver de nada.
    const reclaimedHost =
      !becameHost && !member.viewer && this.owner === member.alias && this.host !== member.alias;
    if (reclaimedHost) this.host = member.alias;

    const outcome = { becameHost, reclaimedHost };
    return previous ? { replaced: previous, ...outcome } : outcome;
  }

  find(channelId: string): RoomMember | undefined {
    return this.members.find((m) => m.channelId === channelId);
  }

  leave(channelId: string): {
    member?: RoomMember;
    abandoned: PendingAsk[];
    newHost?: Alias;
  } {
    const member = this.find(channelId);
    if (!member) return { abandoned: [] };

    this.membersByKey.delete(memberKey(member.alias, member.tag));

    const abandoned: PendingAsk[] = [];
    for (const ask of this.pendingById.values()) {
      if (ask.awaiting.delete(member.alias)) abandoned.push(ask);
    }

    // Una persona puede tener varios tags: solo pierde el mando cuando
    // ya no le queda ninguna conexión en la sala.
    const stillPresent = this.members.some((m) => m.alias === member.alias);
    if (!this.isHost(member.alias) || stillPresent) {
      return { member, abandoned };
    }

    const newHost = this.promoteOldest(member.alias);
    return newHost ? { member, abandoned, newHost } : { member, abandoned };
  }

  channelsOf(alias: Alias): string[] {
    return this.members.filter((m) => m.alias === alias).map((m) => m.channelId);
  }

  roster(): Member[] {
    return this.members.map(toWireMember);
  }

  touch(channelId: string, now: number, quotaRemaining?: number | null): { quotaChanged: boolean } {
    const member = this.find(channelId);
    if (!member) return { quotaChanged: false };

    member.lastSeen = now;
    if (quotaRemaining === undefined) return { quotaChanged: false };

    const quotaChanged = member.quotaRemaining !== quotaRemaining;
    member.quotaRemaining = quotaRemaining;
    return { quotaChanged };
  }

  staleMembers(cutoff: number): RoomMember[] {
    return this.members.filter((m) => m.lastSeen < cutoff);
  }

  openAsk(asker: RoomMember, id: string, target: Target, question: string, now: number): AskOutcome {
    const { bucket, allowed } = consume(
      { tokens: asker.askTokens, updatedAt: asker.askTokensAt },
      this.askPolicy,
      now,
    );
    asker.askTokens = bucket.tokens;
    asker.askTokensAt = bucket.updatedAt;

    if (!allowed) {
      return {
        kind: 'rejected',
        reason: 'rate_limited',
        detail: `máximo ${this.askPolicy.burst} preguntas seguidas; se repone 1 cada ${this.askPolicy.refillMs / 1000}s`,
      };
    }

    if (target === '@auto') {
      const outcome = resolveAuto(this.members, asker.alias, question);
      if (outcome.reason === 'ambiguous') {
        return {
          kind: 'rejected',
          reason: 'target_offline',
          detail:
            'ninguno de los repositorios de la sala encaja con esa pregunta. ' +
            'Dime a quién preguntarle, o usa @all.',
        };
      }
    }

    const targets = resolveTargets(this.members, target, asker.alias, question);
    if (targets.length === 0) {
      return { kind: 'rejected', reason: 'target_offline', detail: `nadie disponible para ${target}` };
    }

    for (const t of targets) t.inFlight += 1;
    this.pendingById.set(id, {
      id,
      from: asker.alias,
      question,
      awaiting: new Set(targets.map((t) => t.alias)),
      startedAt: now,
    });

    return { kind: 'dispatch', targets };
  }

  pending(id: string): PendingAsk | undefined {
    return this.pendingById.get(id);
  }

  askerOf(id: string): RoomMember | undefined {
    const ask = this.pendingById.get(id);
    if (!ask) return undefined;
    return this.members.find((m) => m.alias === ask.from);
  }

  closeFor(id: string, responder: Alias): { settled: boolean } {
    const member = this.members.find((m) => m.alias === responder);
    if (member) member.inFlight = Math.max(0, member.inFlight - 1);

    const ask = this.pendingById.get(id);
    if (!ask) return { settled: true };

    ask.awaiting.delete(responder);
    if (ask.awaiting.size > 0) return { settled: false };

    this.pendingById.delete(id);
    return { settled: true };
  }

  expire(id: string): Alias[] {
    const ask = this.pendingById.get(id);
    if (!ask) return [];

    const stillWaiting = [...ask.awaiting];
    for (const alias of stillWaiting) {
      const member = this.members.find((m) => m.alias === alias);
      if (member) member.inFlight = Math.max(0, member.inFlight - 1);
    }
    this.pendingById.delete(id);
    return stillWaiting;
  }

  record(entry: TranscriptEntry): void {
    this.entries.push(entry);
    if (this.entries.length > TRANSCRIPT_LIMIT) {
      this.entries.splice(0, this.entries.length - TRANSCRIPT_LIMIT);
    }
  }
}
