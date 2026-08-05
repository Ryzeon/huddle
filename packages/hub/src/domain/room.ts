import type { Alias, Member, RoomPolicy, SourceRef, Target } from '@huddle/protocol';
import { memberKey, toWireMember, type RoomMember } from './member.js';
import {
  Admission,
  type AdmissionDecision,
  type ApprovedEntry,
  type WaitingGuest,
} from './admission.js';
import { consume, newBucket, type BucketPolicy } from './rate-limit.js';
import { resolveAuto, resolveTargets } from './routing.js';
import { Folder } from './folder.js';

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

/** Tope de alias firmados por sala: el vínculo no caduca, la memoria sí importa. */
export const MAX_KEYS = 200;

/**
 * Escrituras en la carpeta: veinte de golpe y luego una cada dos segundos.
 * Sobra para trabajar y no llega para machacar a la sala a difusiones.
 */
export const FOLDER_WRITE_POLICY: BucketPolicy = { burst: 20, refillMs: 2_000 };

const KEY_SHAPE = /^[A-Za-z0-9_-]{43}$/;

export class Room {
  private currentCode: string;
  readonly name: string;
  readonly createdAt: number;
  private host?: Alias;

  /**
   * Quien creó la sala. El anfitrión puede cambiar de manos mientras no está,
   * pero al volver lo recupera: la sala es suya, no de quien pasaba por ahí.
   */
  private owner?: Alias;
  private readonly membersByKey = new Map<string, RoomMember>();

  /**
   * Alias vinculados a una clave pública. El vínculo no muere cuando el
   * miembro se va: si muriera, bastaría con esperar a que @ana cerrara el
   * portátil para quedarse con su nombre. Muere con la sala.
   */
  private readonly keysByAlias = new Map<Alias, string>();

  /**
   * Quién puede entrar. Los que esperan NO son miembros: no están en
   * `membersByKey`, así que `roster`, `resolveTargets`, `promoteOldest`,
   * `isEmpty` y `staleMembers` los ignoran sin tener que saber que existen.
   */
  readonly admission = new Admission();

  /**
   * La carpeta de la sala: lo que el equipo deja escrito y lo que el hub anota
   * de cada respuesta. Es de la sala, no de un miembro, así que vive aquí y
   * muere con ella.
   */
  readonly folder = new Folder();

  private readonly pendingById = new Map<string, PendingAsk>();
  private readonly entries: TranscriptEntry[] = [];
  private readonly askPolicy: BucketPolicy;

  /**
   * `createdAt` es obligatorio a propósito: llamar a `Date.now()` aquí dentro
   * sería un reloj escondido en el dominio, y la retención dejaría de poder
   * probarse moviendo el tiempo a mano.
   */
  constructor(code: string, name: string, askPolicy: BucketPolicy, createdAt: number) {
    this.currentCode = code;
    this.name = name;
    this.askPolicy = askPolicy;
    this.createdAt = createdAt;
  }

  get code(): string {
    return this.currentCode;
  }

  /**
   * Cambia el código y devuelve el anterior. No toca nada más: la sala sigue
   * siendo la misma, con su dueño, su anfitrión y su historial.
   */
  rotateCode(next: string): string {
    const previous = this.currentCode;
    this.currentCode = next;
    return previous;
  }

  /**
   * Caduca todas las preguntas en vuelo y las devuelve. Al rotar, quien las
   * respondería está a punto de quedarse fuera.
   */
  expireAll(): PendingAsk[] {
    const abandoned = [...this.pendingById.values()];
    for (const ask of abandoned) {
      for (const alias of ask.awaiting) {
        const member = this.members.find((m) => m.alias === alias);
        if (member) member.inFlight = Math.max(0, member.inFlight - 1);
      }
    }
    this.pendingById.clear();
    return abandoned;
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

  /**
   * Con `write: 'host'` la carpeta es material que se reparte, no que se
   * edita. Con `all` —lo normal— escribe cualquiera de dentro, incluidos los
   * espectadores del portal: dejar una nota no es responder preguntas.
   */
  canWriteFolder(alias: Alias): boolean {
    return this.folder.write === 'all' || this.isHost(alias);
  }

  /**
   * Coge un hueco para escribir en la carpeta.
   *
   * El tope es generoso —un editor que guarda solo, o pegar diez notas de
   * golpe, tienen que caber—, pero existe: cada escritura difunde el estado a
   * toda la sala, así que un cliente en bucle sería N² mensajes por segundo
   * contra todo el mundo.
   */
  allowFolderWrite(member: RoomMember, now: number): boolean {
    const { bucket, allowed } = consume(
      { tokens: member.folderTokens, updatedAt: member.folderTokensAt },
      FOLDER_WRITE_POLICY,
      now,
    );
    member.folderTokens = bucket.tokens;
    member.folderTokensAt = bucket.updatedAt;
    return allowed;
  }

  keyOf(alias: Alias): string | undefined {
    return this.keysByAlias.get(alias);
  }

  /**
   * Ata el alias a la clave y dice si quedó atado. Nunca sobrescribe: un alias
   * ya firmado no cambia de dueño. Devolver `false` en vez de callarse es lo
   * que impide dar la insignia por un vínculo que no se escribió.
   */
  bindKey(alias: Alias, pubkey: string): boolean {
    const bound = this.keysByAlias.get(alias);
    if (bound) return bound === pubkey;
    if (this.keysByAlias.size >= MAX_KEYS) return false;
    this.keysByAlias.set(alias, pubkey);
    return true;
  }

  keySnapshot(): Record<string, string> {
    return Object.fromEntries(this.keysByAlias);
  }

  restoreKeys(keys: Record<string, string>): void {
    for (const [alias, pubkey] of Object.entries(keys)) {
      // Un registro manipulado no debe poder atar un alias a cualquier cosa.
      if (typeof pubkey !== 'string' || !KEY_SHAPE.test(pubkey)) continue;
      if (this.keysByAlias.size >= MAX_KEYS) return;
      this.keysByAlias.set(alias, pubkey);
    }
  }

  /** Los que ocupan ese alias sin haberlo firmado. */
  unsignedChannelsOf(alias: Alias): string[] {
    return this.members.filter((m) => m.alias === alias && !m.pubkey).map((m) => m.channelId);
  }

  get policy(): RoomPolicy {
    return this.admission.isApproved ? 'approved' : 'open';
  }

  get ownerKey(): string | undefined {
    return this.admission.ownerPublicKey;
  }

  restorePolicy(policy: RoomPolicy): void {
    this.admission.restorePolicy(policy);
  }

  restoreOwnerKey(key: string): void {
    this.admission.restoreOwnerKey(key);
  }

  restoreApproved(entries: ApprovedEntry[]): void {
    this.admission.restoreApproved(entries);
  }

  approvedSnapshot(): ApprovedEntry[] {
    return this.admission.approvedSnapshot();
  }

  decideAdmission(key: string | undefined, alias: Alias): AdmissionDecision {
    return this.admission.decide(key, alias);
  }

  addWaiting(guest: WaitingGuest): void {
    this.admission.addWaiting(guest);
  }

  removeWaiting(channelId: string): WaitingGuest | undefined {
    return this.admission.removeWaiting(channelId);
  }

  waitingBy(requestId: string): WaitingGuest | undefined {
    return this.admission.waitingBy(requestId);
  }

  isWaiting(channelId: string): boolean {
    return this.admission.isWaiting(channelId);
  }

  waitingList(): WaitingGuest[] {
    return this.admission.waitingList();
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
    member: Omit<
      RoomMember,
      'inFlight' | 'askTokens' | 'askTokensAt' | 'folderTokens' | 'folderTokensAt' | 'joinedAt'
    >,
    now: number,
  ): { replaced?: RoomMember; becameHost: boolean; reclaimedHost: boolean } {
    const key = memberKey(member.alias, member.tag);
    const previous = this.membersByKey.get(key);

    const bucket = newBucket(this.askPolicy, now);
    const folderBucket = newBucket(FOLDER_WRITE_POLICY, now);
    this.membersByKey.set(key, {
      ...member,
      // Una reconexión conserva su antigüedad: perderla te mandaría al final
      // de la línea de sucesión por un corte de wifi.
      joinedAt: previous?.joinedAt ?? now,
      inFlight: 0,
      askTokens: bucket.tokens,
      askTokensAt: bucket.updatedAt,
      folderTokens: folderBucket.tokens,
      folderTokensAt: folderBucket.updatedAt,
    });

    // Sala recién creada o que se quedó sin anfitrión: manda el que llega,
    // salvo que solo esté mirando.
    const becameHost = this.host === undefined && !member.viewer;
    if (becameHost) this.host = member.alias;
    if (this.owner === undefined && becameHost) this.owner = member.alias;

    // El dueño vuelve: recupera el mando de quien se lo estaba guardando. No
    // cuenta una reconexión de quien ya lo tenía, que no es volver de nada.
    // Un espectador no se convierte en anfitrión por llegar, pero el dueño sí
    // recupera lo suyo aunque entre mirando: el portal siempre entra como
    // espectador, así que exigir lo contrario dejaba al creador sin su sala al
    // recargar la página.
    const reclaimedHost =
      !becameHost && this.owner === member.alias && this.host !== member.alias;
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
