/**
 * Lista de salas recordadas, y el formulario para entrar o crear.
 *
 * La lista sale de `LocalRoomsStore`. Cambiar de sala es cambiar de conexión,
 * así que se hace navegando: hub, código y alias van en la URL, que queda
 * pegable en un chat.
 */

import type { RememberedRoom, RoomsStore } from '../../application/ports/room-feed.js';
import type { SessionState } from '../../domain/session-state.js';
import { clear, el, need } from './dom.js';
import { isotypeElement } from './brand.js';

export interface RoomsHandlers {
  /** Entrar a una sala existente. */
  onOpen(room: { code: string; alias: string; hub: string }): void;
  /** Crear una sala nueva en un hub. */
  onCreate(room: { name: string; alias: string; hub: string }): void;
  onForget(code: string): void;
}

export class RoomsView {
  private readonly list: HTMLElement;
  private readonly dialog: HTMLDialogElement;
  private readonly form: HTMLFormElement;
  private current: string | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly store: RoomsStore,
    private readonly handlers: RoomsHandlers,
    private readonly defaults: { hub: string; alias: string },
  ) {
    this.list = need('[data-salas-lista]', root);
    this.dialog = need<HTMLDialogElement>('[data-dialogo]', document.body);
    this.form = need<HTMLFormElement>('form', this.dialog);

    // Los mismos dos botones están en el lateral y en el estado vacío; ambos
    // abren este diálogo, así que se enganchan todos los del documento.
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-nueva-sala]')) {
      button.addEventListener('click', () => this.openDialog('crear'));
    }
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-entrar-sala]')) {
      button.addEventListener('click', () => this.openDialog('entrar'));
    }

    for (const tab of this.dialog.querySelectorAll<HTMLButtonElement>('[data-modo]')) {
      tab.addEventListener('click', () => this.openDialog(tab.dataset['modo'] === 'crear' ? 'crear' : 'entrar'));
    }

    this.form.addEventListener('submit', (event) => {
      event.preventDefault();
      this.submit();
    });
    need<HTMLButtonElement>('[data-cancelar]', this.dialog).addEventListener('click', () =>
      this.dialog.close(),
    );
  }

  render(state: SessionState): void {
    this.current = state.room;
    this.paint(this.store.list());
  }

  private paint(rooms: RememberedRoom[]): void {
    clear(this.list);

    if (rooms.length === 0) {
      this.list.appendChild(
        el('p', { class: 'salas__vacio', text: 'todavía no has entrado a ninguna sala' }),
      );
      return;
    }

    for (const room of rooms) {
      const active = room.code === this.current;
      const item = el('li', { class: `sala${active ? ' sala--activa' : ''}` });

      const open = el('button', {
        class: 'sala__abrir',
        attrs: { type: 'button', 'aria-current': active ? 'true' : 'false' },
      });
      open.appendChild(isotypeElement(16));
      open.appendChild(
        el('span', {
          class: 'sala__texto',
          children: [
            el('b', { class: 'sala__nombre', text: room.name }),
            el('span', { class: 'sala__codigo', text: room.code }),
          ],
        }),
      );
      open.addEventListener('click', () => {
        if (active) return;
        this.handlers.onOpen({ code: room.code, alias: room.alias, hub: room.hub });
      });

      const forget = el('button', {
        class: 'sala__olvidar',
        text: '×',
        title: `olvidar ${room.code}`,
        attrs: { type: 'button', 'aria-label': `olvidar la sala ${room.name}` },
      });
      forget.addEventListener('click', () => {
        this.handlers.onForget(room.code);
        this.paint(this.store.list());
      });

      item.append(open, forget);
      this.list.appendChild(item);
    }
  }

  private openDialog(mode: 'crear' | 'entrar'): void {
    this.dialog.dataset['modoActual'] = mode;
    for (const tab of this.dialog.querySelectorAll<HTMLButtonElement>('[data-modo]')) {
      const selected = tab.dataset['modo'] === mode;
      tab.classList.toggle('pestana--activa', selected);
      tab.setAttribute('aria-selected', selected ? 'true' : 'false');
    }
    need<HTMLElement>('[data-campo-nombre]', this.dialog).hidden = mode !== 'crear';
    need<HTMLElement>('[data-campo-codigo]', this.dialog).hidden = mode !== 'entrar';
    need<HTMLButtonElement>('[data-aceptar]', this.dialog).textContent =
      mode === 'crear' ? 'crear sala' : 'entrar';

    const hub = need<HTMLInputElement>('[name=hub]', this.form);
    const alias = need<HTMLInputElement>('[name=alias]', this.form);
    if (!hub.value) hub.value = this.defaults.hub;
    if (!alias.value) alias.value = this.defaults.alias;

    if (!this.dialog.open) this.dialog.showModal();
    setTimeout(() => {
      const first = mode === 'crear' ? '[name=nombre]' : '[name=codigo]';
      need<HTMLInputElement>(first, this.form).focus();
    }, 0);
  }

  private submit(): void {
    const mode = this.dialog.dataset['modoActual'] === 'crear' ? 'crear' : 'entrar';
    const data = new FormData(this.form);
    const hub = String(data.get('hub') ?? '').trim();
    const alias = normalizeAlias(String(data.get('alias') ?? ''));
    if (!hub || !alias) return;

    if (mode === 'crear') {
      const name = String(data.get('nombre') ?? '').trim();
      if (!name) return;
      this.handlers.onCreate({ name, alias, hub });
    } else {
      const code = String(data.get('codigo') ?? '').trim().toUpperCase();
      if (!code) return;
      this.handlers.onOpen({ code, alias, hub });
    }
    this.dialog.close();
  }
}

/**
 * Misma regla que `normalizeAlias` del protocolo, reescrita aquí porque el
 * portal solo importa tipos de `@huddle/protocol` y no arrastra su runtime.
 * Devuelve cadena vacía en vez de lanzar: la usa un formulario.
 */
export function normalizeAlias(raw: string): string {
  const trimmed = raw.trim().replace(/^@+/, '').toLowerCase();
  return /^[a-z0-9][a-z0-9_-]{0,31}$/.test(trimmed) ? `@${trimmed}` : '';
}
