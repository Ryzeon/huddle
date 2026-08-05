import { polygonPoints, type TableGeometry } from '../../../domain/table-layout.js';
import { cellGlyph } from '../brand.js';
import { clear, svg } from '../dom.js';

const SIDES = 6;

const INNER_INSET = 10;

const CELL_SIZE = 18;

export function drawBoard(
  layer: SVGGElement,
  geometry: TableGeometry,
  busy: boolean,
  files = 0,
): void {
  clear(layer);
  const { cx, cy, tableRadius } = geometry;

  layer.appendChild(hexagon(cx, cy, tableRadius, 'mesa__tablero'));
  layer.appendChild(
    hexagon(cx, cy, tableRadius - INNER_INSET, 'mesa__tablero mesa__tablero--interior'),
  );

  // En el centro va la celda y nada más: el código de sala ya está en la
  // cabecera, y ahí solo estorbaría a los arcos.
  const center = svg('g', { attrs: { transform: `translate(${cx} ${cy})` } });
  const cell = cellGlyph(CELL_SIZE);
  if (busy) cell.classList.add('mesa__celda--activa');
  center.appendChild(cell);

  // La carpeta, debajo de la celda: en la mesa hay una carpeta, y el dibujo
  // tiene que decirlo. Es decorativa —el panel de verdad se abre desde la
  // cabecera—, así que solo aparece cuando hay algo dentro.
  if (files > 0) center.appendChild(folderGlyph(files));

  layer.appendChild(center);
}

const FOLDER_TOP = CELL_SIZE / 2 + 12;
const FOLDER_WIDTH = 26;
const FOLDER_HEIGHT = 18;

function folderGlyph(files: number): SVGGElement {
  const group = svg('g', { class: 'mesa__carpeta' });
  const x = -FOLDER_WIDTH / 2;

  group.appendChild(
    svg('path', {
      class: 'mesa__carpeta-forma',
      attrs: {
        d:
          `M ${x} ${FOLDER_TOP + 4} v ${FOLDER_HEIGHT - 4} h ${FOLDER_WIDTH} ` +
          `v ${-FOLDER_HEIGHT} h ${-FOLDER_WIDTH * 0.55} l -2.5 4 z`,
      },
    }),
  );
  group.appendChild(
    svg('text', {
      class: 'mesa__carpeta-cuenta',
      text: String(files),
      attrs: { x: 0, y: FOLDER_TOP + FOLDER_HEIGHT + 12, 'text-anchor': 'middle' },
    }),
  );

  return group;
}

function hexagon(cx: number, cy: number, radius: number, className: string): SVGElement {
  return svg('polygon', {
    class: className,
    attrs: { points: polygonPoints(cx, cy, radius, SIDES) },
  });
}
