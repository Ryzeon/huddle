import type { RememberedRoom, RoomsStore } from '../../application/ports/room-feed.js';
import type { SessionState } from '../../domain/session-state.js';
import { readUploads, type Upload } from '../../domain/uploads.js';
import { clear, el, need } from './dom.js';
import { isotypeElement } from './brand.js';

/** Lo que se decide al crear una sala y ya no cambia. */
export interface NewRoom {
  name: string;
  alias: string;
  hub: string;
  approved: boolean;
  folderHost: boolean;
  folderMemory: boolean;
  /** Con lo que empieza la carpeta. Se sube en cuanto la sala existe. */
  uploads: Upload[];
  /** Lo que no se pudo leer, para contarlo cuando ya haya sala. */
  rechazados: string[];
}

export interface RoomsHandlers {
  onOpen(room: { code: string; alias: string; hub: string }): void;
  onCreate(room: NewRoom): void;
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
    /**
     * `canSign` decide si se puede ofrecer la aprobación: el hub rechaza crear
     * una sala con puerta si el cliente no puede firmar, y ofrecerla igual
     * sería prometer una cerradura que no se va a poner.
     */
    private readonly defaults: { hub: string; alias: string; canSign: boolean },
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
      void this.submit();
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

    const ajustes = this.dialog.querySelector<HTMLElement>('[data-ajustes-sala]');
    if (ajustes) ajustes.hidden = mode !== 'crear';

    const aprobacion = this.dialog.querySelector<HTMLInputElement>('[data-campo-aprobacion]');
    if (aprobacion) {
      aprobacion.disabled = !this.defaults.canSign;
      if (!this.defaults.canSign) {
        aprobacion.checked = false;
        aprobacion.title = 'este navegador no puede firmar tu alias, y sin firma la puerta no cierra';
      }
    }
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

  private async submit(): Promise<void> {
    const mode = this.dialog.dataset['modoActual'] === 'crear' ? 'crear' : 'entrar';
    const data = new FormData(this.form);
    const hub = String(data.get('hub') ?? '').trim();
    const alias = normalizeAlias(String(data.get('alias') ?? ''));
    if (!hub || !alias) return;

    if (mode === 'crear') {
      const name = String(data.get('nombre') ?? '').trim();
      if (!name) return;

      // Se leen aquí, antes de navegar: los `File` no sobreviven a la recarga
      // que abre la sala nueva, pero su texto sí.
      const sueltos = this.dialog.querySelector<HTMLInputElement>('[name=archivos]')?.files;
      const carpeta = this.dialog.querySelector<HTMLInputElement>('[name=carpeta]')?.files;
      const elegidos = [...(sueltos ?? []), ...(carpeta ?? [])];
      const { ok, rechazados } =
        elegidos.length > 0 ? await readUploads(elegidos) : { ok: [], rechazados: [] };

      this.handlers.onCreate({
        uploads: ok,
        rechazados,
        name,
        alias,
        hub,
        approved: data.get('aprobacion') !== null && this.defaults.canSign,
        folderHost: data.get('carpeta-host') !== null,
        // La casilla dice «no dejar escritas», así que va al revés que el dato.
        folderMemory: data.get('sin-memoria') === null,
      });
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
