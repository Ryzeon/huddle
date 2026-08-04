/**
 * Reproduce `demo-script` implementando el mismo puerto que `WsRoomFeed`, así
 * que las vistas no notan la diferencia.
 *
 * Lo que se manda por `send` se refleja de vuelta como si lo hubiera reenviado
 * el hub, para poder probar la caja de escribir.
 */

import type { PortalClientMessage, RoomFeed } from '../../application/ports/room-feed.js';
import type { PortalEvent } from '../../domain/session-state.js';
import { DEMO_SCRIPT, DEMO_YOU, type ScriptedEvent } from './demo-script.js';

export interface DemoRoomFeedOptions {
  script?: readonly ScriptedEvent[];
  /** 1 = tiempo real; 2 = el doble de rápido. Útil para las capturas. */
  speed?: number;
  /**
   * Reproduce el guion entero sin esperas. Lo usan las capturas: deja la sala
   * en su estado final sin dormir veinte segundos.
   */
  instant?: boolean;
  /** Hasta qué instante del guion reproducir en modo instantáneo. */
  untilMs?: number;
}

export class DemoRoomFeed implements RoomFeed {
  private readonly listeners = new Set<(event: PortalEvent) => void>();
  private timers: Array<ReturnType<typeof setTimeout>> = [];
  private running = false;

  constructor(private readonly options: DemoRoomFeedOptions = {}) {}

  start(): void {
    if (this.running) return;
    this.running = true;

    const script = this.options.script ?? DEMO_SCRIPT;
    const speed = this.options.speed && this.options.speed > 0 ? this.options.speed : 1;

    if (this.options.instant) {
      const until = this.options.untilMs ?? Number.POSITIVE_INFINITY;
      for (const item of script) {
        if (item.at <= until) this.emit(item.event);
      }
      return;
    }

    for (const item of script) {
      this.timers.push(setTimeout(() => this.emit(item.event), item.at / speed));
    }
  }

  stop(): void {
    this.running = false;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
  }

  /** Vuelve a empezar desde cero. Lo llama el botón «repetir». */
  restart(): void {
    this.stop();
    this.start();
  }

  subscribe(listener: (event: PortalEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * En demo no hay a quién mandar, así que se hace eco. Un `msg` vuelve como
   * mensaje de la sala; un `ask` genera las dos fases de `activity` y el
   * `result`, igual que haría el hub.
   */
  send(message: PortalClientMessage): void {
    if (message.t === 'msg') {
      this.emit({ t: 'msg', from: DEMO_YOU, text: message.text });
      return;
    }
    if (message.t === 'ask') {
      const { id, to, q } = message;
      this.emit({ t: 'activity', id, from: DEMO_YOU, to, phase: 'asking' });
      this.timers.push(
        setTimeout(() => {
          this.emit({ t: 'activity', id, from: DEMO_YOU, to, phase: 'answered', elapsedMs: 2400 });
          this.emit({
            t: 'result',
            id,
            from: to,
            answer: `(demo) no hay agente detrás, pero tu pregunta era: «${q}»`,
            sources: [{ file: 'packages/portal/src/adapters/outbound/demo-room-feed.ts', line: 1 }],
            confidence: 'low',
            elapsedMs: 2400,
            cached: false,
          });
        }, 2400),
      );
      return;
    }
    if (message.t === 'kick') {
      this.emit({ t: 'note', text: `(demo) expulsarías a ${message.alias}`, tone: 'system' });
    }
  }

  private emit(event: PortalEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
