import type { Alias, ResultMessage } from '@huddle/protocol';
import type { Room } from '../../domain/room.js';
import type { ClockPort } from '../ports/member-channel.js';
import type { RoomNotifier, RelayableMessage } from '../state/room-notifier.js';
import type { AskTimeouts } from '../state/ask-timeouts.js';
import type { TranscriptStorePort } from '../ports/member-channel.js';

export interface RelayCommand {
  room: Room;
  responder: Alias;
  message: RelayableMessage;
}

export interface FinishAnswerCommand {
  room: Room;
  responder: Alias;
  message: ResultMessage;
}

export interface RelayAnswerDeps {
  notifier: RoomNotifier;
  timeouts: AskTimeouts;
  clock: ClockPort;
  transcripts: TranscriptStorePort;
}

/**
 * Devuelve al que preguntó lo que produce el que responde.
 *
 * Tres casos con reglas distintas:
 *  - `chunk`/`trace`: puro reenvío, la pregunta sigue viva.
 *  - `result`: reenvía, archiva en el transcript y cierra.
 *  - `error`: reenvía y cierra, sin archivar.
 */
export class RelayAnswerHandler {
  constructor(private readonly deps: RelayAnswerDeps) {}

  /** `chunk` y `trace`: la pregunta sigue abierta. */
  relayProgress({ room, responder, message }: RelayCommand): void {
    this.deps.notifier.toAsker(room, message, responder);
  }

  /** `result`: última entrega de este agente para esta pregunta. */
  finish({ room, responder, message }: FinishAnswerCommand): void {
    const { notifier, clock } = this.deps;
    const pending = room.pending(message.id);

    notifier.toAsker(room, message, responder);

    if (pending) {
      notifier.broadcast(room, {
        t: 'activity',
        id: message.id,
        from: pending.from,
        to: responder,
        phase: 'answered',
        elapsedMs: message.elapsedMs,
        cached: message.cached,
      });

      const entry = {
        id: message.id,
        from: pending.from,
        to: responder,
        question: pending.question,
        answer: message.answer,
        sources: message.sources,
        confidence: message.confidence,
        sha: message.sha,
        branch: message.branch,
        elapsedMs: message.elapsedMs,
        cached: message.cached,
        at: clock.now(),
      };
      room.record(entry);
      // A disco al vuelo: si el hub muere, no hay ventana en la que exista
      // una respuesta que no esté ya en el historial.
      this.deps.transcripts.append(room.code, room.name, entry);
    }

    this.settle(room, message.id, responder);
  }

  /** `error`: se reenvía y se cierra, pero no se archiva un fallo. */
  fail({ room, responder, message }: RelayCommand): void {
    const pending = room.pending(message.id);
    this.deps.notifier.toAsker(room, message, responder);

    if (pending) {
      this.deps.notifier.broadcast(room, {
        t: 'activity',
        id: message.id,
        from: pending.from,
        to: responder,
        phase: 'failed',
      });
    }

    this.settle(room, message.id, responder);
  }

  /**
   * Marca que este agente terminó. Solo cuando ya no falta nadie se cancela
   * el timeout: en un `@all` la pregunta sigue viva hasta el último.
   */
  private settle(room: Room, askId: string, responder: Alias): void {
    const { settled } = room.closeFor(askId, responder);
    if (settled) this.deps.timeouts.cancel(askId);
    this.deps.notifier.broadcastRoster(room);
  }
}
