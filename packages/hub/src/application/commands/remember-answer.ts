/**
 * Deja escrita en la carpeta cada respuesta que se da en la sala.
 *
 * El transcript ya guardaba lo mismo, pero solo lo lee quien abre el
 * historial. Esto lo pone donde el agente de todos ya está mirando: en la
 * carpeta que se replica en su disco. La diferencia entre un registro y una
 * memoria es exactamente esa.
 *
 * Lo escribe el hub y no cada agente a propósito: N daemons generando la misma
 * nota se pisarían entre ellos y difundirían N veces el mismo cambio.
 */

import type { CapabilityCard } from '@huddle/protocol';
import type { Room, TranscriptEntry } from '../../domain/room.js';
import { FOLDER_README, buildNote, linkInto } from '../../domain/note.js';
import type { RoomNotifier } from '../state/room-notifier.js';

export interface RememberAnswerDeps {
  notifier: RoomNotifier;
  log: (message: string) => void;
}

export interface RememberAnswerCommand {
  room: Room;
  entry: TranscriptEntry;
  /** La tarjeta de quien respondió: de sus keywords salen los temas. */
  card?: CapabilityCard;
}

export class RememberAnswerHandler {
  constructor(private readonly deps: RememberAnswerDeps) {}

  /** Devuelve `true` si la carpeta cambió y hay que persistirla. */
  remember({ room, entry, card }: RememberAnswerCommand): boolean {
    if (!room.folder.memory) return false;

    const note = buildNote({
      id: entry.id,
      room: room.code,
      from: entry.from,
      to: entry.to,
      question: entry.question,
      answer: entry.answer,
      sources: entry.sources,
      confidence: entry.confidence,
      sha: entry.sha,
      branch: entry.branch,
      at: entry.at,
      repo: card?.repo,
      keywords: card?.keywords,
    });

    // El README explica qué es `respuestas/` y qué no hay que editar, así que
    // va con la primera nota generada — no cuando la carpeta está vacía. Si
    // alguien ya había escrito a mano, la carpeta no está vacía y aun así es
    // la primera vez que aparece algo que no escribió él.
    if (!room.folder.read('README.md')) {
      room.folder.put('README.md', FOLDER_README, entry.to, entry.at);
    }

    const outcome = room.folder.put(note.path, note.text, entry.to, entry.at);
    if (outcome.kind === 'full') {
      this.deps.log(`no cupo la nota de ${entry.id} en la carpeta de #${room.code}`);
      return false;
    }

    for (const nodePath of note.links) {
      const previous = room.folder.read(nodePath)?.text;
      const text = linkInto(previous, note.path, nodePath);
      // `null` es que el enlace ya estaba: reescribir el nodo difundiría un
      // cambio que no cambia nada.
      if (text) room.folder.put(nodePath, text, entry.to, entry.at);
    }

    this.deps.notifier.broadcastFolder(room);
    return true;
  }
}
