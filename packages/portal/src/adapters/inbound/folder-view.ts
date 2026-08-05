/**
 * La carpeta de la sala: la lista a la izquierda, lo que hay dentro a la
 * derecha.
 *
 * Se abre sobre la mesa en vez de vivir en el lateral porque compite con el
 * chat por la atención, no con la mesa: se mira un momento, se lee algo y se
 * cierra.
 *
 * El contenido se pide de uno en uno. La carpeta puede tener 500 archivos de
 * 256 KB, y bajarlos todos para enseñar una lista de nombres sería mover 100
 * MB por un panel que casi siempre se abre para leer uno.
 */

import type { FolderEntry } from '@huddle/protocol';
import type { SessionState } from '../../domain/session-state.js';
import { readUploads } from '../../domain/uploads.js';
import { clear, el, need } from './dom.js';
import { renderMarkdown } from './markdown-view.js';

export interface FolderViewOptions {
  onOpen: (path: string) => void;
  onClose: () => void;
  onWrite: (path: string, text: string) => void;
  /** Varios de una vez: un zip o una carpeta entera. */
  onWriteMany: (files: readonly { path: string; text: string }[]) => void;
  onRemove: (path: string) => void;
  /** Para contar lo que no se pudo subir, en el hilo de la sesión. */
  onNote: (text: string) => void;
}

/** Lo que genera el hub. No se edita desde aquí: se regenera solo. */
const GENERATED = ['respuestas/', 'temas/', 'gente/'];

function isGenerated(path: string): boolean {
  return GENERATED.some((prefix) => path.startsWith(prefix));
}

export class FolderView {
  private readonly list: HTMLElement;
  private readonly viewer: HTMLElement;
  private readonly title: HTMLElement;
  private readonly newButton: HTMLButtonElement;
  private readonly upload: HTMLInputElement;
  private readonly uploadLabel: HTMLElement;
  private readonly uploadDir: HTMLInputElement;
  private readonly uploadDirLabel: HTMLElement;

  private open = false;
  /** Se recuerda para no repintar la lista entera en cada latido. */
  private painted = '';
  private editing: string | null = null;
  private state: SessionState | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly options: FolderViewOptions,
  ) {
    this.list = need<HTMLElement>('[data-carpeta-lista]', root);
    this.viewer = need<HTMLElement>('[data-carpeta-visor]', root);
    this.title = need<HTMLElement>('[data-carpeta-titulo]', root);
    this.newButton = need<HTMLButtonElement>('[data-carpeta-nueva]', root);

    need<HTMLButtonElement>('[data-carpeta-cerrar]', root).addEventListener('click', () => {
      this.hide();
    });

    this.newButton.addEventListener('click', () => this.edit(null));

    this.uploadLabel = need<HTMLElement>('[data-carpeta-subir-etiqueta]', root);
    this.upload = need<HTMLInputElement>('[data-carpeta-subir]', root);
    this.upload.addEventListener('change', () => {
      void this.take(this.upload.files);
      // Sin esto, elegir el mismo archivo dos veces seguidas no dispara nada:
      // el valor no cambia y el `change` no llega.
      this.upload.value = '';
    });

    this.uploadDirLabel = need<HTMLElement>('[data-carpeta-carpeta-etiqueta]', root);
    this.uploadDir = need<HTMLInputElement>('[data-carpeta-carpeta]', root);
    this.uploadDir.addEventListener('change', () => {
      void this.take(this.uploadDir.files);
      this.uploadDir.value = '';
    });

    // Arrastrar es la forma natural de meter algo en una carpeta. El
    // `dragover` hay que cancelarlo o el navegador abre el archivo y se lleva
    // la página por delante.
    this.root.addEventListener('dragover', (event) => {
      if (!this.state || !this.canWrite(this.state)) return;
      event.preventDefault();
      this.root.classList.add('carpeta--soltar');
    });
    this.root.addEventListener('dragleave', () => this.root.classList.remove('carpeta--soltar'));
    this.root.addEventListener('drop', (event) => {
      event.preventDefault();
      this.root.classList.remove('carpeta--soltar');
      void this.take(event.dataTransfer?.files ?? null);
    });

    // Escape cierra lo que esté abierto de dentro afuera: primero el editor o
    // el archivo, y solo después el panel. Cerrarlo todo de golpe pierde lo que
    // se estaba escribiendo por un tecleo de más.
    this.root.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      if (this.editing !== null) this.edit(undefined);
      else if (this.state?.folderOpen) this.options.onClose();
      else this.hide();
    });
  }

  get isOpen(): boolean {
    return this.open;
  }

  show(): void {
    this.open = true;
    this.root.hidden = false;
    this.root.querySelector<HTMLElement>('[data-carpeta-lista] button')?.focus();
  }

  hide(): void {
    this.open = false;
    this.editing = null;
    this.root.hidden = true;
    this.options.onClose();
  }

  toggle(): void {
    if (this.open) this.hide();
    else this.show();
  }

  render(state: SessionState): void {
    this.state = state;

    // Sin sala no hay carpeta que enseñar, y dejar el panel abierto sobre una
    // mesa vacía es enseñar la carpeta de una sala de la que ya se salió.
    if (state.room === null && this.open) this.hide();

    const puedeEscribir = this.canWrite(state);
    this.newButton.hidden = !puedeEscribir;
    this.uploadLabel.hidden = !puedeEscribir;
    this.uploadDirLabel.hidden = !puedeEscribir;
    this.paintList(state);
    this.paintViewer(state);
  }

  /**
   * Mete archivos del disco en la carpeta de la sala.
   *
   * Solo texto, y de uno en uno por `folder_put`. Un binario no aporta nada
   * aquí: lo que hace útil la carpeta es que el agente pueda leerla y citarla,
   * y un PNG o un PDF no se leen con Grep.
   */
  private async take(files: FileList | null): Promise<void> {
    if (!files || files.length === 0 || !this.state || !this.canWrite(this.state)) return;

    const { ok, rechazados } = await readUploads(files);
    if (ok.length > 0) this.options.onWriteMany(ok);
    for (const motivo of rechazados) this.options.onNote(motivo);
  }

  /**
   * Un espectador escribe si la sala lo permite: dejar una nota no es
   * responder preguntas. Con `write: host`, solo el anfitrión.
   */
  private canWrite(state: SessionState): boolean {
    if (state.room === null) return false;
    if (state.folderWrite === 'all') return true;
    return state.host !== null && state.host === state.you?.split(':')[0];
  }

  private paintList(state: SessionState): void {
    const clave = state.folder.map((entry) => `${entry.path}:${entry.at}`).join('|');
    if (clave === this.painted) return;
    this.painted = clave;

    clear(this.list);

    if (state.folder.length === 0) {
      this.list.appendChild(
        el('p', {
          class: 'carpeta__vacia',
          text: this.canWrite(state)
            ? 'la carpeta está vacía. lo que escribas aquí lo leerá el agente de todos.'
            : 'la carpeta está vacía.',
        }),
      );
      return;
    }

    this.list.appendChild(this.branch(buildTree(state.folder), 0));
  }

  /**
   * Una rama del árbol.
   *
   * Las carpetas son `<details>` a propósito: plegar y desplegar sale gratis,
   * funciona con el teclado y lo anuncia un lector de pantalla sin que haya que
   * escribir un solo atributo ARIA.
   */
  private branch(nodes: Nodo[], depth: number): HTMLElement {
    const ul = el('ul', { class: 'carpeta__items' });

    for (const node of nodes) {
      if (node.entry) {
        ul.appendChild(this.item(node.entry, node.nombre, depth));
        continue;
      }

      const hijos = this.branch(node.hijos, depth + 1);
      const carpeta = el('details', { class: 'carpeta__rama', attrs: { open: true } });
      const titulo = el('summary', {
        class: 'carpeta__carpeta',
        text: node.nombre,
        attrs: { style: `padding-inline-start:${10 + depth * 14}px` },
      });
      carpeta.append(titulo, hijos);
      ul.appendChild(el('li', { children: [carpeta] }));
    }

    return ul;
  }

  private item(entry: FolderEntry, nombre: string, depth: number): HTMLElement {
    const abrir = el('button', {
      class: 'carpeta__archivo',
      text: nombre,
      title: `${entry.path} · ${entry.by}`,
      attrs: {
        type: 'button',
        'data-ruta': entry.path,
        style: `padding-inline-start:${10 + depth * 14}px`,
      },
    });
    abrir.addEventListener('click', () => this.options.onOpen(entry.path));

    const acciones = el('span', { class: 'carpeta__acciones' });
    if (!isGenerated(entry.path) && this.state && this.canWrite(this.state)) {
      const editar = el('button', {
        class: 'boton boton--fino',
        text: 'editar',
        attrs: { type: 'button' },
      });
      editar.addEventListener('click', () => this.edit(entry.path));

      const borrar = el('button', {
        class: 'boton boton--fino',
        text: 'borrar',
        attrs: { type: 'button' },
      });
      // Sin confirmación de dos toques como en «cerrar sala»: aquí lo perdido
      // es un archivo que el hub aún tiene, no la sala entera.
      borrar.addEventListener('click', () => this.options.onRemove(entry.path));

      acciones.append(editar, borrar);
    }

    return el('li', { class: 'carpeta__item', children: [abrir, acciones] });
  }

  private paintViewer(state: SessionState): void {
    if (this.editing !== null) return; // el editor manda mientras esté abierto

    const open = state.folderOpen;
    if (!open) {
      this.title.textContent = `${state.folder.length} archivo(s)`;
      clear(this.viewer);
      this.viewer.appendChild(
        el('p', {
          class: 'carpeta__pista',
          text: 'elige un archivo. lo que hay aquí lo lee el agente de cada miembro de la sala.',
        }),
      );
      return;
    }

    this.title.textContent = open.path;
    clear(this.viewer);

    if (open.text === undefined) {
      this.viewer.appendChild(el('p', { class: 'carpeta__pista', text: 'cargando…' }));
      return;
    }

    const { meta, body } = splitFrontmatter(open.text);
    if (meta.length > 0) this.viewer.appendChild(metaBlock(meta));

    const cuerpo = el('article', { class: 'carpeta__md' });
    const rendered = renderMarkdown(body);
    // Los wikilinks son el grafo. Dejarlos como texto obligaría a buscar el
    // archivo a mano en la lista, que es justo lo que el enlace evita.
    linkify(rendered, state.folder.map((entry) => entry.path), (path) =>
      this.options.onOpen(path),
    );
    cuerpo.appendChild(rendered);
    this.viewer.appendChild(cuerpo);
  }

  /**
   * Abre el editor. `null` crea una nota nueva; `undefined` lo cierra.
   *
   * Se escribe siempre bajo `notas/`: el resto de la carpeta lo genera el hub y
   * lo reescribiría en la siguiente respuesta.
   */
  private edit(path: string | null | undefined): void {
    if (path === undefined) {
      this.editing = null;
      if (this.state) this.paintViewer(this.state);
      return;
    }

    this.editing = path ?? '';
    clear(this.viewer);

    const nombre = el('input', {
      class: 'carpeta__nombre',
      attrs: {
        type: 'text',
        value: path ?? 'notas/',
        placeholder: 'notas/lo-que-sea.md',
        spellcheck: 'false',
        readonly: path !== null,
      },
    });

    const texto = el('textarea', {
      class: 'carpeta__editor',
      attrs: { rows: '16', spellcheck: 'false' },
    });
    texto.value = path !== null ? (this.state?.folderOpen?.text ?? '') : '';

    const guardar = el('button', {
      class: 'boton boton--principal',
      text: 'guardar para toda la sala',
      attrs: { type: 'button' },
    });
    guardar.addEventListener('click', () => {
      const ruta = nombre.value.trim();
      if (!ruta || !texto.value.trim()) return;
      this.options.onWrite(ruta, texto.value);
      this.editing = null;
    });

    const cancelar = el('button', {
      class: 'boton boton--fino',
      text: 'cancelar',
      attrs: { type: 'button' },
    });
    cancelar.addEventListener('click', () => this.edit(undefined));

    this.title.textContent = path ?? 'nota nueva';
    this.viewer.append(
      nombre,
      texto,
      el('div', { class: 'carpeta__botones', children: [cancelar, guardar] }),
    );
    nombre.focus();
  }
}

/**
 * Separa el frontmatter del cuerpo.
 *
 * Sin esto, las notas que escribe el hub empiezan con seis líneas de `clave:
 * valor` entre guiones, que en markdown se leen como un párrafo cualquiera.
 * Son metadatos y se pintan como metadatos.
 */
export function splitFrontmatter(text: string): {
  meta: Array<[string, string]>;
  body: string;
} {
  if (!text.startsWith('---\n')) return { meta: [], body: text };

  const end = text.indexOf('\n---', 3);
  if (end < 0) return { meta: [], body: text };

  const meta: Array<[string, string]> = [];
  for (const line of text.slice(4, end).split('\n')) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    meta.push([line.slice(0, colon).trim(), line.slice(colon + 1).trim().replace(/^"|"$/g, '')]);
  }

  return { meta, body: text.slice(end + 4).replace(/^\n+/, '') };
}

function metaBlock(meta: Array<[string, string]>): HTMLElement {
  const dl = el('dl', { class: 'carpeta__meta' });
  for (const [key, value] of meta) {
    dl.append(el('dt', { text: key }), el('dd', { text: value }));
  }
  return dl;
}

const WIKILINK = /\[\[([^\]|]+)\]\]/g;

/**
 * Convierte `[[ruta]]` en algo que se puede pulsar.
 *
 * Un enlace a algo que ya no está en la carpeta —una nota que se llevó la
 * poda— se queda apagado en vez de desaparecer: dice «aquí hubo algo», que es
 * más honesto que borrarlo.
 */
export function linkify(
  root: DocumentFragment | HTMLElement,
  paths: readonly string[],
  onOpen: (path: string) => void,
): void {
  const known = new Set(paths);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);

  const targets: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.textContent?.includes('[[')) targets.push(node as Text);
  }

  for (const node of targets) {
    const source = node.textContent ?? '';
    const parts = document.createDocumentFragment();
    let last = 0;

    for (const match of source.matchAll(WIKILINK)) {
      const at = match.index ?? 0;
      if (at > last) parts.appendChild(document.createTextNode(source.slice(last, at)));

      const target = match[1]!.trim();
      const path = known.has(target) ? target : known.has(`${target}.md`) ? `${target}.md` : null;

      if (path) {
        const link = el('button', {
          class: 'carpeta__enlace',
          text: target,
          attrs: { type: 'button' },
        });
        link.addEventListener('click', () => onOpen(path));
        parts.appendChild(link);
      } else {
        parts.appendChild(
          el('span', {
            class: 'carpeta__enlace carpeta__enlace--roto',
            text: target,
            title: 'ya no está en la carpeta',
          }),
        );
      }

      last = at + match[0].length;
    }

    if (last < source.length) parts.appendChild(document.createTextNode(source.slice(last)));
    node.replaceWith(parts);
  }
}

/**
 * Un nodo del árbol: o tiene contenido, o tiene hijos.
 *
 * Es la forma que la carpeta tiene de verdad. La lista plana agrupada valía
 * para cuatro notas; con un vault dentro, lo que se necesita es el árbol.
 */
interface Nodo {
  nombre: string;
  hijos: Nodo[];
  entry?: FolderEntry;
}

export function buildTree(entries: readonly FolderEntry[]): Nodo[] {
  const raiz: Nodo = { nombre: '', hijos: [] };

  for (const entry of entries) {
    const partes = entry.path.split('/');
    let actual = raiz;

    for (const [i, parte] of partes.entries()) {
      const hoja = i === partes.length - 1;
      let hijo = actual.hijos.find((n) => n.nombre === parte && Boolean(n.entry) === hoja);

      if (!hijo) {
        hijo = { nombre: parte, hijos: [] };
        if (hoja) hijo.entry = entry;
        actual.hijos.push(hijo);
      }
      actual = hijo;
    }
  }

  ordenar(raiz.hijos);
  return raiz.hijos;
}

/** Carpetas antes que archivos, y cada grupo por nombre: como cualquier árbol. */
function ordenar(nodos: Nodo[]): void {
  nodos.sort((a, b) => {
    const carpetaA = a.entry ? 1 : 0;
    const carpetaB = b.entry ? 1 : 0;
    return carpetaA - carpetaB || a.nombre.localeCompare(b.nombre);
  });
  for (const nodo of nodos) ordenar(nodo.hijos);
}

