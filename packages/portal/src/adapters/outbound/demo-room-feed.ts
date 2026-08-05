import type { PortalClientMessage, RoomFeed } from '../../application/ports/room-feed.js';
import type { PortalEvent } from '../../domain/session-state.js';
import { DEMO_FILES, DEMO_SCRIPT, DEMO_YOU, type ScriptedEvent } from './demo-script.js';

export interface DemoRoomFeedOptions {
  script?: readonly ScriptedEvent[];
  speed?: number;
    // Lo usan las capturas: deja la sala en su estado final sin dormir 20 s.
  instant?: boolean;
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

  restart(): void {
    this.stop();
    this.start();
  }

  subscribe(listener: (event: PortalEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

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
    if (message.t === 'folder_get') {
      // Sin esto el visor se queda cargando para siempre: en la demostración
      // no hay hub que conteste.
      this.emit({
        t: 'folder_file',
        id: message.id,
        path: message.path,
        text: DEMO_FILES[message.path] ?? `# ${message.path}\n\n(demo) sin contenido.`,
        at: Date.now(),
      });
      return;
    }
    if (message.t === 'folder_put' || message.t === 'folder_drop') {
      this.emit({
        t: 'note',
        text:
          message.t === 'folder_put'
            ? `(demo) escribirías ${message.path} para toda la sala`
            : `(demo) borrarías ${message.path} para toda la sala`,
        tone: 'system',
      });
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
