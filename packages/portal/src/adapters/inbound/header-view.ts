/**
 * La cabecera: nombre de la sala, código, anfitrión y estado de conexión.
 *
 * El código va en mono, en mayúsculas, sin partir de línea y con botón de
 * copiar: es la única llave de la sala y se comparte a mano.
 */

import type { SessionState } from '../../domain/session-state.js';
import { logoElement } from './brand.js';
import { need } from './dom.js';

export interface HeaderHandlers {
  onCopyCode(code: string): void;
  onToggleTheme(): void;
}

const ESTADO: Record<string, { texto: string; clase: string }> = {
  idle: { texto: 'sin conectar', clase: 'apagado' },
  connecting: { texto: 'conectando', clase: 'esperando' },
  online: { texto: 'en sala', clase: 'ok' },
  offline: { texto: 'sin conexión', clase: 'mal' },
  closed: { texto: 'sala cerrada', clase: 'mal' },
};

export class HeaderView {
  private readonly name: HTMLElement;
  private readonly code: HTMLElement;
  private readonly copy: HTMLButtonElement;
  private readonly host: HTMLElement;
  private readonly you: HTMLElement;
  private readonly status: HTMLElement;
  private readonly count: HTMLElement;

  constructor(root: HTMLElement, handlers: HeaderHandlers) {
    need<HTMLElement>('[data-marca]', root).appendChild(logoElement(132));
    this.name = need('[data-sala-nombre]', root);
    this.code = need('[data-sala-codigo]', root);
    this.copy = need<HTMLButtonElement>('[data-copiar]', root);
    this.host = need('[data-anfitrion]', root);
    this.you = need('[data-tu]', root);
    this.status = need('[data-estado]', root);
    this.count = need('[data-miembros]', root);

    this.copy.addEventListener('click', () => {
      const code = this.code.textContent ?? '';
      if (code) handlers.onCopyCode(code);
    });
    need<HTMLButtonElement>('[data-tema]', root).addEventListener('click', () =>
      handlers.onToggleTheme(),
    );
  }

  render(state: SessionState): void {
    this.name.textContent = state.roomName ?? 'sin sala';
    this.code.textContent = state.room ?? '—';
    this.copy.disabled = state.room === null;
    this.host.textContent = state.host ?? '—';
    this.you.textContent = state.you ?? '—';

    const estado = ESTADO[state.status] ?? ESTADO['idle']!;
    this.status.textContent = state.detail ? `${estado.texto} · ${state.detail}` : estado.texto;
    this.status.dataset['tono'] = estado.clase;

    this.count.textContent = String(state.members.length);
  }

  /** Confirmación efímera del botón de copiar. */
  flashCopied(): void {
    const previous = this.copy.textContent;
    this.copy.textContent = 'copiado';
    this.copy.classList.add('boton--hecho');
    setTimeout(() => {
      this.copy.textContent = previous;
      this.copy.classList.remove('boton--hecho');
    }, 1400);
  }
}
