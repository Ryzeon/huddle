import type { PortalClientMessage, RoomFeed } from './ports/room-feed.js';
import type { Activity, PortalEvent, SessionState } from '../domain/session-state.js';
import {
  ACTIVITY_TTL_MS,
  initialState,
  pruneActivities,
  reduce,
} from '../domain/session-state.js';

export type Clock = () => number;

export interface SessionStoreDeps {
  feed: RoomFeed;
  clock?: Clock;
  onActivity?: (activity: Activity) => void;
}

export class SessionStore {
  private state: SessionState = initialState();
  private readonly listeners = new Set<(state: SessionState) => void>();
  private readonly clock: Clock;
  private unsubscribe: (() => void) | null = null;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: SessionStoreDeps) {
    this.clock = deps.clock ?? (() => Date.now());
  }

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.deps.feed.subscribe((event) => this.ingest(event));
    this.pruneTimer = setInterval(() => {
      const pruned = pruneActivities(this.state, this.clock());
      if (pruned !== this.state) this.commit(pruned);
    }, ACTIVITY_TTL_MS / 2);
    this.deps.feed.start();
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.pruneTimer = null;
    this.deps.feed.stop();
  }

  getState(): SessionState {
    return this.state;
  }

  subscribe(listener: (state: SessionState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  sendMessage(text: string): void {
    this.send({ t: 'msg', text });
  }

  ask(to: string, question: string, ttlSeconds = 90): void {
    this.send({ t: 'ask', id: newLocalId(), to, q: question, ttl: ttlSeconds });
  }

  kick(alias: string, reason?: string): void {
    this.send(reason ? { t: 'kick', alias, reason } : { t: 'kick', alias });
  }

  /** Cierra la sala para todos. El hub solo lo acepta del anfitrión. */
  closeRoom(): void {
    this.send({ t: 'close' });
  }

  /** Cambia el código de la sala. El hub solo lo acepta del anfitrión. */
  rotateCode(reason?: string): void {
    const id = newLocalId();
    this.send(reason ? { t: 'rotate', id, reason } : { t: 'rotate', id });
  }

  note(text: string, tone: 'system' | 'failed' = 'system'): void {
    this.ingest({ t: 'note', text, tone });
  }

  private send(message: PortalClientMessage): void {
    this.deps.feed.send(message);
  }

  private ingest(event: PortalEvent): void {
    const next = reduce(this.state, event, this.clock());
    if (event.t === 'activity') {
      const activity = next.activities.find((a) => a.id === event.id);
      if (activity) this.deps.onActivity?.(activity);
    }
    this.commit(next);
  }

  private commit(next: SessionState): void {
    if (next === this.state) return;
    this.state = next;
    for (const listener of this.listeners) listener(next);
  }
}

/**
 * Id para las preguntas que salen del portal. Mismo formato ordenable que
 * `newId()` del protocolo, reescrito aquí porque el portal solo importa tipos
 * y no arrastra el runtime del paquete al navegador.
 */
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function newLocalId(now = Date.now(), random = Math.random): string {
  let time = '';
  let n = now;
  for (let i = 0; i < 10; i++) {
    time = (B32[n % 32] ?? '0') + time;
    n = Math.floor(n / 32);
  }
  let rand = '';
  for (let i = 0; i < 8; i++) rand += B32[Math.floor(random() * 32)] ?? '0';
  return time + rand;
}
