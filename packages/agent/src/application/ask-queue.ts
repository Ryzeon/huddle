// Turno de espera de las preguntas entrantes.
//
// La concurrencia es de la suscripción, no del repositorio, así que la cola
// también: si expones tres repos, las preguntas de los tres hacen la misma
// fila. Por eso vive junto a la cuota, en el composition root, y no dentro de
// un caso de uso.

import type { ClockPort, LoggerPort } from './ports/index.js';

export interface QueuedAsk {
  id: string;
  from: string;
  /** Epoch ms tras el cual responder ya no sirve de nada. */
  deadline: number;
  run: () => Promise<void>;
  /** Se llama si la pregunta caduca esperando, o si no cabe en la cola. */
  drop: (detail: string) => void;
}

export interface AskQueueDeps {
  clock: ClockPort;
  logger?: LoggerPort;
}

export class AskQueue {
  private readonly waiting: QueuedAsk[] = [];

  constructor(
    private readonly deps: AskQueueDeps,
    private readonly maxWaiting: number,
  ) {}

  get size(): number {
    return this.waiting.length;
  }

  /**
   * Mete la pregunta en la fila. Devuelve la posición, o `null` si la cola
   * está llena: encolar sin tope convierte una ráfaga en una espera eterna, y
   * es más honesto decir que no desde el principio.
   */
  enqueue(ask: QueuedAsk): number | null {
    this.dropExpired();
    if (this.waiting.length >= this.maxWaiting) return null;
    this.waiting.push(ask);
    return this.waiting.length;
  }

  /**
   * Arranca las que quepan. `reserve` intenta coger un hueco de concurrencia y
   * dice si lo consiguió; así la cola no necesita saber cómo se cuenta.
   */
  pump(reserve: () => boolean): void {
    this.dropExpired();

    while (this.waiting.length > 0) {
      if (!reserve()) return;

      const next = this.waiting.shift();
      if (!next) return;

      // El `run` ya libera su hueco al terminar y vuelve a llamar aquí, así
      // que no se espera: encadenarlas aquí serializaría toda la cola.
      void next.run().catch((error: unknown) => {
        this.deps.logger?.warn(
          `falló una pregunta en cola: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }
  }

  /** Responder tarde es peor que no responder: quien preguntó ya se fue. */
  private dropExpired(): void {
    const now = this.deps.clock.now();
    for (let i = this.waiting.length - 1; i >= 0; i--) {
      const ask = this.waiting[i];
      if (ask && ask.deadline <= now) {
        this.waiting.splice(i, 1);
        ask.drop('caducó esperando turno');
      }
    }
  }
}
