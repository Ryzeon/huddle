/**
 * Temporizadores de las preguntas en vuelo.
 *
 * Vive aparte porque lo comparten dos comandos: `AskQuestion` los programa y
 * `RelayAnswer` / `LeaveRoom` los cancelan. Si cada uno guardara los suyos,
 * una respuesta a tiempo no cancelaría el timeout y el que preguntó recibiría
 * la respuesta *y* un error de timeout después.
 */

import type { CancelTimer, TimerPort } from '../ports/member-channel.js';

export class AskTimeouts {
  private readonly pending = new Map<string, CancelTimer>();

  constructor(private readonly timers: TimerPort) {}

  schedule(askId: string, delayMs: number, onExpire: () => void): void {
    this.cancel(askId); // reprogramar nunca debe dejar dos vivos
    this.pending.set(
      askId,
      this.timers.schedule(delayMs, () => {
        this.pending.delete(askId);
        onExpire();
      }),
    );
  }

  cancel(askId: string): void {
    this.pending.get(askId)?.();
    this.pending.delete(askId);
  }

  get size(): number {
    return this.pending.size;
  }
}
