import type { Alias, ResultMessage } from '@huddle/protocol';
import type { Room } from '../../domain/room.js';
import type { ClockPort } from '../ports/member-channel.js';
import type { RoomNotifier, RelayableMessage } from '../state/room-notifier.js';
import type { AskTimeouts } from '../state/ask-timeouts.js';
import type { TranscriptStorePort } from '../ports/member-channel.js';
import type { RoomMember } from '../../domain/member.js';
import type { RememberAnswerHandler } from './remember-answer.js';

export interface RelayCommand {
  room: Room;
  responder: Alias;
  message: RelayableMessage;
}

export interface FinishAnswerCommand {
  room: Room;
  /**
   * El miembro, no solo su alias: la nota que se guarda en la carpeta sale de
   * su tarjeta de capacidades, que es donde están el repositorio y las
   * palabras con las que se clasifica.
   */
  responder: RoomMember;
  message: ResultMessage;
}

export interface RelayAnswerDeps {
  notifier: RoomNotifier;
  timeouts: AskTimeouts;
  clock: ClockPort;
  transcripts: TranscriptStorePort;
  /** Sin esto, la respuesta se relaya y se archiva, pero no se recuerda. */
  remember?: RememberAnswerHandler;
}

export class RelayAnswerHandler {
  constructor(private readonly deps: RelayAnswerDeps) {}

  relayProgress({ room, responder, message }: RelayCommand): void {
    this.deps.notifier.toAsker(room, message, responder);
  }

  /** Devuelve `true` si la carpeta cambió y hay que persistir la sala. */
  finish({ room, responder, message }: FinishAnswerCommand): boolean {
    const { notifier, clock } = this.deps;
    const pending = room.pending(message.id);
    let remembered = false;

    notifier.toAsker(room, message, responder.alias);

    if (pending) {
      notifier.broadcast(room, {
        t: 'activity',
        id: message.id,
        from: pending.from,
        to: responder.alias,
        phase: 'answered',
        elapsedMs: message.elapsedMs,
        cached: message.cached,
      });

      const entry = {
        id: message.id,
        from: pending.from,
        to: responder.alias,
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

      // Y a la carpeta, que es donde la va a encontrar el agente del siguiente
      // que pregunte. Una respuesta fallida no se recuerda: no hay nada que
      // aprender de un `agent_failed`.
      remembered =
        this.deps.remember?.remember({ room, entry, card: responder.card }) ?? false;
    }

    this.settle(room, message.id, responder.alias);
    return remembered;
  }

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

  private settle(room: Room, askId: string, responder: Alias): void {
    const { settled } = room.closeFor(askId, responder);
    if (settled) this.deps.timeouts.cancel(askId);
    this.deps.notifier.broadcastRoster(room);
  }
}
