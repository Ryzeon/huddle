/**
 * Logo e isotipo en SVG, con la misma geometría que `brand/logo.svg` y
 * `brand/isotipo.svg` pero pintados con `currentColor` para que hereden el
 * tema.
 *
 * Están copiados aquí, y no cargados por red, para que la cabecera se pinte
 * sin ninguna petición.
 */

import { svg } from './dom.js';

/** Caja nativa del símbolo, tal cual está en los archivos de marca. */
const SYMBOL_BOX = 120;
const CHEVRON_LEFT = 'M10 4.48 L42 52.48 L42 67.52 L10 115.52 L10 88.48 L28.99 60 L10 31.52 Z';
const CHEVRON_RIGHT = 'M110 4.48 L78 52.48 L78 67.52 L110 115.52 L110 88.48 L91.01 60 L110 31.52 Z';

/** Trazos del logotipo monolínea, en su caja original. */
const WORDMARK_PATHS = [
  'M0 28 V100',
  'M0 72 Q0 56 17 56 Q34 56 34 72 V100',
  'M62 56 V84 Q62 100 79 100 Q96 100 96 84 V56',
  'M158 28 V100',
  'M158 56 Q124 56 124 78 Q124 100 158 100',
  'M220 28 V100',
  'M220 56 Q186 56 186 78 Q186 100 220 100',
  'M248 28 V100',
  'M308 92 Q302 100 293 100 Q276 100 276 78 Q276 56 293 56 Q310 56 310 78 H276',
];

/**
 * Logo horizontal. Por debajo de 120 px de ancho devuelve el isotipo, que es
 * lo que la marca pide a ese tamaño. No hay versión intermedia.
 */
export function logoElement(width = 168): SVGSVGElement {
  if (width < 120) return isotypeElement(Math.max(16, Math.round(width / 3)));

  const root = svg('svg', {
    class: 'marca',
    attrs: {
      viewBox: '0 0 416 120',
      width,
      height: Math.round((width * 120) / 416),
      role: 'img',
      'aria-label': 'huddle',
      focusable: 'false',
    },
  });

  const symbol = svg('g', { attrs: { transform: 'translate(2.2 13.2) scale(0.78)' } });
  const chevrons = svg('g', { attrs: { fill: 'currentColor' } });
  chevrons.appendChild(svg('path', { attrs: { d: CHEVRON_LEFT } }));
  chevrons.appendChild(svg('path', { attrs: { d: CHEVRON_RIGHT } }));
  symbol.appendChild(chevrons);
  // La celda es el único elemento a color de toda la composición.
  symbol.appendChild(
    svg('rect', { attrs: { x: 49, y: 49, width: 22, height: 22, fill: 'var(--acento)' } }),
  );
  root.appendChild(symbol);

  const wordmark = svg('g', {
    attrs: {
      transform: 'translate(120 2.4) scale(0.9)',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': 12.5,
      'stroke-linecap': 'butt',
      'stroke-linejoin': 'miter',
    },
  });
  for (const d of WORDMARK_PATHS) wordmark.appendChild(svg('path', { attrs: { d } }));
  root.appendChild(wordmark);

  return root;
}

/** Isotipo cuadrado, sin fondo propio: va sobre el color del tema. */
export function isotypeElement(size = 24): SVGSVGElement {
  const root = svg('svg', {
    class: 'marca marca--iso',
    attrs: {
      viewBox: `0 0 ${SYMBOL_BOX} ${SYMBOL_BOX}`,
      width: size,
      height: size,
      role: 'img',
      'aria-label': 'huddle',
      focusable: 'false',
    },
  });
  const chevrons = svg('g', { attrs: { fill: 'currentColor' } });
  chevrons.appendChild(svg('path', { attrs: { d: CHEVRON_LEFT } }));
  chevrons.appendChild(svg('path', { attrs: { d: CHEVRON_RIGHT } }));
  root.appendChild(chevrons);
  root.appendChild(
    svg('rect', { attrs: { x: 49, y: 49, width: 22, height: 22, fill: 'var(--acento)' } }),
  );
  return root;
}

/**
 * Símbolo monocromo para el interior de un nodo de la mesa. Devuelve un `<g>`
 * centrado en el origen, listo para colocar con `transform`.
 *
 * Monocromo a propósito: la marca admite un solo ámbar por composición, y en
 * la mesa se lo queda la celda del centro.
 */
export function agentGlyph(size: number): SVGGElement {
  const scale = size / SYMBOL_BOX;
  const group = svg('g', {
    class: 'nodo__glifo',
    attrs: {
      transform: `translate(${-size / 2} ${-size / 2}) scale(${round(scale)})`,
      fill: 'currentColor',
    },
  });
  group.appendChild(svg('path', { attrs: { d: CHEVRON_LEFT } }));
  group.appendChild(svg('path', { attrs: { d: CHEVRON_RIGHT } }));
  group.appendChild(svg('rect', { attrs: { x: 49, y: 49, width: 22, height: 22 } }));
  return group;
}

/** La celda sola: el cursor, la pregunta compartida, el centro de la mesa. */
export function cellGlyph(size: number): SVGRectElement {
  return svg('rect', {
    class: 'mesa__celda',
    attrs: { x: -size / 2, y: -size / 2, width: size, height: size },
  });
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}
