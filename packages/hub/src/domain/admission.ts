import type { Alias, CapabilityCard, RoomPolicy } from '@huddle/protocol';

export interface ApprovedEntry {
  key: string;
  alias: Alias;
  at: number;
}

export interface WaitingGuest {
  id: string;
  channelId: string;
  alias: Alias;
  tag?: string;
  key: string;
  card?: CapabilityCard;
  viewer?: boolean;
  at: number;
}

export type AdmissionDecision =
  /** La sala es abierta, o esta clave ya está aprobada con ese alias. */
  | { kind: 'admit' }
  /** A la puerta. */
  | { kind: 'wait' }
  /** No hay sitio en la puerta. */
  | { kind: 'full' };

/** Tope de gente esperando. Más allá, la cola es un vector de ruido, no una cola. */
export const MAX_WAITING_GUESTS = 20;

/**
 * Quién entra en una sala con aprobación.
 *
 * Se indexa por clave pública, nunca por alias: aprobar un alias aprobaría a
 * cualquiera que lo escriba, y eso es exactamente lo que la firma evita.
 */
export class Admission {
  private policy: RoomPolicy = 'open';
  private ownerKey?: string;
  private readonly approvedByKey = new Map<string, ApprovedEntry>();
  private readonly waitingByChannel = new Map<string, WaitingGuest>();

  get isApproved(): boolean {
    return this.policy === 'approved';
  }

  restorePolicy(policy: RoomPolicy): void {
    this.policy = policy;
  }

  restoreOwnerKey(key: string): void {
    this.ownerKey = key;
  }

  restoreApproved(entries: ApprovedEntry[]): void {
    for (const entry of entries) {
      this.approvedByKey.set(entry.key, entry);
    }
  }

  get ownerPublicKey(): string | undefined {
    return this.ownerKey;
  }

  approvedSnapshot(): ApprovedEntry[] {
    return [...this.approvedByKey.values()];
  }

  /** El alias con el que esa clave entró antes, si entró. */
  aliasOwner(key: string): Alias | undefined {
    return this.approvedByKey.get(key)?.alias;
  }

  decide(key: string | undefined, alias: Alias): AdmissionDecision {
    if (this.policy !== 'approved') return { kind: 'admit' };
    if (!key) return { kind: 'wait' };

    // El dueño no pide permiso para entrar en su propia sala.
    if (key === this.ownerKey) return { kind: 'admit' };

    // Aprobado, pero con SU alias: aprobar a alguien no es darle la sala para
    // que entre luego como @quien-sea.
    if (this.approvedByKey.get(key)?.alias === alias) return { kind: 'admit' };

    if (this.waitingByChannel.size >= MAX_WAITING_GUESTS) return { kind: 'full' };
    return { kind: 'wait' };
  }

  /** Encola. Si esa clave ya esperaba, sustituye: insistir no es hacer cola dos veces. */
  addWaiting(guest: WaitingGuest): void {
    for (const [channelId, waiting] of this.waitingByChannel) {
      if (waiting.key === guest.key) this.waitingByChannel.delete(channelId);
    }
    this.waitingByChannel.set(guest.channelId, guest);
  }

  removeWaiting(channelId: string): WaitingGuest | undefined {
    const guest = this.waitingByChannel.get(channelId);
    if (guest) this.waitingByChannel.delete(channelId);
    return guest;
  }

  waitingBy(requestId: string): WaitingGuest | undefined {
    for (const guest of this.waitingByChannel.values()) {
      if (guest.id === requestId) return guest;
    }
    return undefined;
  }

  isWaiting(channelId: string): boolean {
    return this.waitingByChannel.has(channelId);
  }

  waitingList(): WaitingGuest[] {
    return [...this.waitingByChannel.values()];
  }

  /** Aprueba por id de solicitud, nunca por alias. Devuelve a quién. */
  approve(requestId: string, remember: boolean, at: number): WaitingGuest | undefined {
    const guest = this.waitingBy(requestId);
    if (!guest) return undefined;

    this.waitingByChannel.delete(guest.channelId);
    if (remember) {
      this.approvedByKey.set(guest.key, { key: guest.key, alias: guest.alias, at });
    }
    return guest;
  }

  deny(requestId: string): WaitingGuest | undefined {
    const guest = this.waitingBy(requestId);
    if (!guest) return undefined;
    this.waitingByChannel.delete(guest.channelId);
    return guest;
  }

  /** Expulsar a alguien tiene que quitarle también el permiso, o no es expulsarlo. */
  revokeByAlias(alias: Alias): void {
    for (const [key, entry] of this.approvedByKey) {
      if (entry.alias === alias) this.approvedByKey.delete(key);
    }
  }
}
