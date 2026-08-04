// El SVG es un dibujo y un lector de pantalla no puede recorrerlo, asi que va
// marcado como decorativo y esta lista lo duplica en texto.
//
// Sin `aria-live`: las altas y bajas ya las canta el chat, que es un `role="log"`.

import type { Member } from '@huddle/protocol';
import { memberLabel, type Seat } from '../../../domain/table-layout.js';
import type { SessionState } from '../../../domain/session-state.js';

export class RosterSummary {
  private readonly list: HTMLUListElement;

  constructor(host: HTMLElement) {
    this.list = document.createElement('ul');
    this.list.className = 'visualmente-oculto';
    this.list.setAttribute('aria-label', 'quién está en la mesa');
    host.appendChild(this.list);
  }

  update(seats: readonly Seat[], state: SessionState): void {
    this.list.replaceChildren(
      ...seats.map((seat) => {
        const member = state.members.find((each) => memberLabel(each) === seat.label);
        const item = document.createElement('li');
        item.textContent = describe(seat, member, state);
        return item;
      }),
    );
  }

  clear(): void {
    this.list.replaceChildren();
  }
}

function describe(seat: Seat, member: Member | undefined, state: SessionState): string {
  const traits: string[] = [];
  if (state.host !== null && seat.alias === state.host) traits.push('anfitrión');
  if (seat.label === state.you) traits.push('tú');
  if (member?.viewer === true) traits.push('espectador');
  if (state.busy.includes(seat.alias) || state.busy.includes(seat.label)) {
    traits.push('respondiendo');
  }
  if (member?.status === 'offline') traits.push('desconectado');

  const repo = seat.tag ?? member?.card?.repo;
  const head = repo ? `${seat.alias}, repositorio ${repo}` : seat.alias;
  return traits.length > 0 ? `${head} (${traits.join(', ')})` : head;
}
