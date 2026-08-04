/**
 * Agregado Sala.
 *
 * Guarda quién está, qué preguntas hay en vuelo y el transcript. No manda
 * mensajes: devuelve *decisiones* (a quién hay que entregar qué) y deja el
 * envío a la capa de aplicación. Esa separación es lo que permite probar el
 * ruteo, los timeouts y las desconexiones sin abrir un socket.
 */

import type { Alias, Member, SourceRef, Target } from '@huddle/protocol';
import { memberKey, toWireMember, type RoomMember } from './member.js';
import { consume, newBucket, type BucketPolicy } from './rate-limit.js';
import { resolveAuto, resolveTargets } from './routing.js';

export interface PendingAsk {
  readonly id: string;
  readonly from: Alias;
  readonly question: string;
  /** Agentes de los que todavía se espera respuesta. */
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
  /** Código único: la llave para entrar. */
  readonly code: string;
  /** Nombre legible que le puso quien la creó. */
  readonly name: string;
  /** Epoch ms de creación. Se conserva al resucitarla desde disco. */
  readonly createdAt: number;
  /** Quién manda. Puede expulsar; al irse, hereda el más antiguo. */
  private host?: Alias;
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

  /** Reemplaza el historial en memoria; lo usa la purga por antigüedad. */
  replaceTranscript(entries: TranscriptEntry[]): void {
    this.entries.length = 0;
    this.entries.push(...entries);
  }

  get hostAlias(): Alias | undefined {
    return this.host;
  }

  isHost(alias: Alias): boolean {
    return this.host === alias;
  }

  /**
   * El más antiguo de los presentes, excluyendo a quien acaba de salir.
   * Se mide por `joinedAt`, no por orden del Map: una reconexión no debe
   * colar a alguien por delante en la línea de sucesión.
   */
  private oldestMember(excluding?: Alias): Alias | undefined {
    let oldest: RoomMember | undefined;
    for (const member of this.members) {
      // Un observador no puede heredar el mando: no responde ni expulsa.
      if (member.alias === excluding || member.viewer) continue;
      if (!oldest || member.joinedAt < oldest.joinedAt) oldest = member;
    }
    return oldest?.alias;
  }

  /**
   * Traspasa el mando al más antiguo. Devuelve el nuevo anfitrión, o
   * `undefined` si no queda nadie — ahí la sala se cierra.
   */
  promoteOldest(excluding?: Alias): Alias | undefined {
    this.host = this.oldestMember(excluding);
    return this.host;
  }

  // -- Membresía ------------------------------------------------------------

  get members(): RoomMember[] {
    return [...this.membersByKey.values()];
  }

  get isEmpty(): boolean {
    return this.membersByKey.size === 0;
  }

  get transcript(): readonly TranscriptEntry[] {
    return this.entries;
  }

  /**
   * Admite un miembro. Si ya había uno con el mismo alias+tag devuelve el
   * anterior para que la aplicación cierre su canal: así una reconexión no
   * deja un fantasma en el roster.
   */
  join(
    member: Omit<RoomMember, 'inFlight' | 'askTokens' | 'askTokensAt' | 'joinedAt'>,
    now: number,
  ): { replaced?: RoomMember; becameHost: boolean } {
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

    return previous ? { replaced: previous, becameHost } : { becameHost };
  }

  find(channelId: string): RoomMember | undefined {
    return this.members.find((m) => m.channelId === channelId);
  }

  /**
   * Saca a un miembro y devuelve las preguntas que dejó colgadas, para que la
   * aplicación avise a quien preguntaba en vez de dejarlo esperando al TTL.
   */
  leave(channelId: string): {
    member?: RoomMember;
    abandoned: PendingAsk[];
    /** Nuevo anfitrión, si el que salió lo era y queda gente. */
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

  /** Todas las conexiones de un alias: expulsar echa todos sus tags. */
  channelsOf(alias: Alias): string[] {
    return this.members.filter((m) => m.alias === alias).map((m) => m.channelId);
  }

  roster(): Member[] {
    return this.members.map(toWireMember);
  }

  /**
   * Refresca el latido y, si viene, la cuota.
   *
   * Devuelve si la cuota cambió: difundir el roster en *cada* latido serían
   * N² mensajes cada 20s, pero no difundirlo nunca deja la cuota obsoleta en
   * la UI de todos. Difundimos solo cuando el valor cambió de verdad.
   */
  touch(channelId: string, now: number, quotaRemaining?: number | null): { quotaChanged: boolean } {
    const member = this.find(channelId);
    if (!member) return { quotaChanged: false };

    member.lastSeen = now;
    if (quotaRemaining === undefined) return { quotaChanged: false };

    const quotaChanged = member.quotaRemaining !== quotaRemaining;
    member.quotaRemaining = quotaRemaining;
    return { quotaChanged };
  }

  /** Miembros sin latido desde `cutoff`. */
  staleMembers(cutoff: number): RoomMember[] {
    return this.members.filter((m) => m.lastSeen < cutoff);
  }

  // -- Preguntas ------------------------------------------------------------

  /**
   * Decide qué hacer con una pregunta: a quién entregarla, o por qué no.
   * Registra la pregunta como pendiente solo si hay a quién mandarla.
   */
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

  /** A quién hay que reenviarle lo que llega para la pregunta `id`. */
  askerOf(id: string): RoomMember | undefined {
    const ask = this.pendingById.get(id);
    if (!ask) return undefined;
    return this.members.find((m) => m.alias === ask.from);
  }

  /**
   * Marca que un agente terminó con una pregunta. Cierra la pregunta cuando ya
   * no falta nadie, para que el timeout de la aplicación pueda descartarse.
   */
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

  /** Abandona la pregunta y devuelve de quién se estaba esperando respuesta. */
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
