import type { PendingGuest, SessionState } from '../../domain/session-state.js';

export interface ApprovalsHandlers {
  onAdmit(id: string): void;
  onDeny(id: string): void;
}

/** Cuánto dura armado el botón de aprobar antes de desarmarse solo. */
const ARM_MS = 4_000;

/**
 * La puerta: quién espera, y la pantalla de espera si el que espera eres tú.
 *
 * El alias y la clave se pintan al mismo nivel visual a propósito. El alias lo
 * elige quien entra y no prueba nada; la clave sí. Enseñar el alias grande y
 * la clave en letra pequeña invitaría a decidir por el nombre.
 */
export class ApprovalsView {
  private armed: string | null = null;
  private disarm?: ReturnType<typeof setTimeout>;
  private last?: SessionState;

  constructor(
    private readonly host: HTMLElement,
    private readonly handlers: ApprovalsHandlers,
  ) {}

  render(state: SessionState): void {
    this.last = state;
    if (state.waitingInfo) return this.renderWaiting(state);
    if (state.pending.length === 0) {
      this.host.hidden = true;
      this.host.replaceChildren();
      return;
    }

    this.host.hidden = false;
    this.host.replaceChildren(
      title(`${state.pending.length} esperando a entrar`),
      ...state.pending.map((guest) => this.card(guest)),
    );
  }

  private renderWaiting(state: SessionState): void {
    const info = state.waitingInfo;
    if (!info) return;

    this.host.hidden = false;
    const bloque = document.createElement('div');
    bloque.className = 'puerta__espera';
    bloque.append(
      title(`esperando a que ${info.host} te deje entrar`),
      line(`sala: ${info.roomName}`),
      line(
        info.key
          ? `tu clave: …${info.key} — dísela para que sepa que eres tú`
          : 'entras sin firmar: este navegador no puede firmar tu alias',
      ),
    );
    this.host.replaceChildren(bloque);
  }

  private card(guest: PendingGuest): HTMLElement {
    const card = document.createElement('div');
    card.className = 'puerta__ficha';

    const label = guest.tag ? `${guest.alias}:${guest.tag}` : guest.alias;
    card.append(line(label), line(`clave …${guest.key}`));
    if (guest.repo) card.append(line(guest.repo));
    if (guest.knownAlias) card.append(line(`ya entró antes como ${guest.knownAlias}`));

    const admitir = document.createElement('button');
    admitir.type = 'button';
    admitir.className = 'boton boton--fino';
    admitir.textContent =
      this.armed === guest.id ? '¿seguro? comprueba la clave' : 'dejar entrar';
    if (this.armed === guest.id) admitir.classList.add('boton--peligro');
    admitir.addEventListener('click', () => this.arm(guest.id));

    const rechazar = document.createElement('button');
    rechazar.type = 'button';
    rechazar.className = 'boton boton--fino';
    rechazar.textContent = 'no';
    rechazar.addEventListener('click', () => this.handlers.onDeny(guest.id));

    const acciones = document.createElement('div');
    acciones.className = 'puerta__acciones';
    acciones.append(admitir, rechazar);
    card.append(acciones);

    return card;
  }

  /** Dos toques, como expulsar: dejar entrar a quien no es no tiene deshacer. */
  private arm(id: string): void {
    if (this.armed === id) {
      clearTimeout(this.disarm);
      this.armed = null;
      this.handlers.onAdmit(id);
      return;
    }
    clearTimeout(this.disarm);
    this.armed = id;
    this.repaint();
    this.disarm = setTimeout(() => {
      this.armed = null;
      this.repaint();
    }, ARM_MS);
  }

  private repaint(): void {
    if (this.last) this.render(this.last);
  }
}

function title(text: string): HTMLElement {
  const node = document.createElement('h2');
  node.className = 'puerta__titulo';
  node.textContent = text;
  return node;
}

function line(text: string): HTMLElement {
  const node = document.createElement('p');
  node.className = 'puerta__linea';
  node.textContent = text;
  return node;
}
