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
