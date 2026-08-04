import { polygonPoints, type TableGeometry } from '../../../domain/table-layout.js';
import { cellGlyph } from '../brand.js';
import { clear, svg } from '../dom.js';

const SIDES = 6;

const INNER_INSET = 10;

const CELL_SIZE = 18;

export function drawBoard(layer: SVGGElement, geometry: TableGeometry, busy: boolean): void {
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
  layer.appendChild(center);
}

function hexagon(cx: number, cy: number, radius: number, className: string): SVGElement {
  return svg('polygon', {
    class: className,
    attrs: { points: polygonPoints(cx, cy, radius, SIDES) },
  });
}
