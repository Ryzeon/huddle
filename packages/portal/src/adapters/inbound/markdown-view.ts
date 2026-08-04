// Convierte el markdown ya parseado en nodos. Todo entra por `textContent`.

import { blockToText, parseMarkdown, type Block, type Inline } from '../../domain/markdown.js';
import { el } from './dom.js';

export function renderMarkdown(source: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  for (const block of parseMarkdown(source)) fragment.appendChild(renderBlock(block));
  return fragment;
}

// Un `#` de markdown no puede ser un `h1` dentro del chat: la página ya tiene
// su jerarquía y romperla desordena el índice para un lector de pantalla.
const HEADINGS = ['h3', 'h4', 'h5', 'h6'] as const;

function renderBlock(block: Block): HTMLElement {
  switch (block.kind) {
    case 'code': {
      const wrap = el('div', { class: 'md-codigo' });
      const pre = el('pre');
      pre.appendChild(el('code', { text: block.value }));
      if (block.language) pre.setAttribute('data-lenguaje', block.language);
      wrap.appendChild(pre);
      wrap.appendChild(botonCopiar(block.value, 'copiar el código'));
      return wrap;
    }

    case 'list': {
      const list = block.ordered
        ? el('ol', { class: 'md-lista' })
        : el('ul', { class: 'md-lista' });
      for (const item of block.items) list.appendChild(fill(el('li'), item));
      return list;
    }

    case 'quote':
      return fill(el('blockquote', { class: 'md-cita' }), block.content);

    case 'heading':
      return fill(el(HEADINGS[Math.min(block.level, 4) - 1] ?? 'h5', { class: 'md-titulo' }), block.content);

    default:
      return fill(el('p', { class: 'md-parrafo' }), block.content);
  }
}

function fill<T extends HTMLElement>(host: T, content: Inline[]): T {
  for (const part of content) {
    switch (part.kind) {
      case 'code':
        host.appendChild(el('code', { class: 'md-en-linea', text: part.value }));
        break;
      case 'bold':
        host.appendChild(el('strong', { text: part.value }));
        break;
      case 'italic':
        host.appendChild(el('em', { text: part.value }));
        break;
      case 'mention':
        host.appendChild(el('span', { class: 'mencion', text: part.value }));
        break;
      default:
        host.appendChild(document.createTextNode(part.value));
    }
  }
  return host;
}

/**
 * El botón se queda en «copiado» un momento y vuelve solo. Sin confirmación no
 * se sabe si el clic hizo algo, y un aviso permanente sobra.
 */
export function botonCopiar(texto: string, etiqueta: string): HTMLButtonElement {
  const boton = el('button', {
    class: 'boton boton--fino md-copiar',
    text: 'copiar',
    attrs: { type: 'button', 'aria-label': etiqueta },
  }) as HTMLButtonElement;

  let volver: ReturnType<typeof setTimeout> | undefined;

  boton.addEventListener('click', () => {
    void navigator.clipboard.writeText(texto).then(
      () => marcar('copiado'),
      () => marcar('no se pudo'),
    );
  });

  function marcar(estado: string): void {
    boton.textContent = estado;
    boton.classList.add('boton--hecho');
    clearTimeout(volver);
    volver = setTimeout(() => {
      boton.textContent = 'copiar';
      boton.classList.remove('boton--hecho');
    }, 1_400);
  }

  return boton;
}

/** Lo que se copia de una respuesta entera. */
export function textoPlano(source: string): string {
  return parseMarkdown(source).map(blockToText).join('\n\n');
}
