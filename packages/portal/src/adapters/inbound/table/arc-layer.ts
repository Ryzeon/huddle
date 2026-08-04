/**
 * Los arcos: el trazo que viaja de un nodo a otro cuando alguien pregunta, y
 * el que vuelve con la respuesta.
 *
 * Los extremos se guardan por alias y no por coordenada. Con coordenadas, al
 * cambiar de tamaño la ventana los nodos se recolocan y el arco se queda
 * flotando donde estaban antes.
 */

import { arcBetween, type Seat, type TableGeometry } from '../../../domain/table-layout.js';
import { svg } from '../dom.js';
import { TIMING, type ShouldAnimate } from './timing.js';

export type ArcTone = 'pregunta' | 'respuesta' | 'fallo';

/** Cuánto se queda el arco quieto antes de desvanecerse, y de borrarse. */
const LINGER_MS = 1_400;
const REMOVE_MS = 2_100;

/** Largo del destello que recorre el arco marcando el sentido. */
const GLINT_LENGTH = 22;

/** Separación entre el arco y el borde del tablero, para que no lo roce. */
const BOARD_CLEARANCE = 16;

/** Separación entre el arco y el borde del nodo. */
const NODE_CLEARANCE = 4;

interface DrawnArc {
  group: SVGGElement;
  from: string;
  to: string;
}

export class ArcLayer {
  private readonly arcs = new Map<string, DrawnArc>();

  constructor(
    private readonly layer: SVGGElement,
    private readonly nodeRadius: number,
    private readonly shouldAnimate: ShouldAnimate,
  ) {}

  draw(
    id: string,
    from: Seat,
    to: Seat,
    tone: ArcTone,
    duration: number,
    geometry: TableGeometry,
    label?: string,
  ): void {
    const arc = curve(from, to, geometry, this.nodeRadius);
    if (!arc) return;

    const group = svg('g', { class: `arco arco--${tone}`, attrs: { 'data-arco': id } });
    const line = svg('path', { class: 'arco__linea', attrs: { d: arc.d } });
    group.appendChild(line);

    if (label) {
      group.appendChild(
        svg('text', {
          class: 'arco__etiqueta',
          text: label,
          attrs: { x: arc.midX, y: arc.midY - 6, 'text-anchor': 'middle' },
        }),
      );
    }

    this.layer.appendChild(group);
    this.arcs.set(id, { group, from: from.label, to: to.label });
    this.scheduleRemoval(id, group, duration);

    if (this.shouldAnimate()) this.playTravel(group, line, arc.d, duration);
  }

  /** Quita un arco al instante. Lo usa la vuelta para tapar la ida. */
  fade(id: string): void {
    this.arcs.get(id)?.group.remove();
    this.arcs.delete(id);
  }

  /**
   * Recalcula los arcos vivos contra los asientos de ahora. Se llama en cada
   * render, que es también lo que ocurre al cambiar de tamaño la ventana.
   */
  reposition(geometry: TableGeometry, seatOf: (label: string) => Seat | undefined): void {
    for (const [id, drawn] of [...this.arcs]) {
      const from = seatOf(drawn.from);
      const to = seatOf(drawn.to);
      if (!from || !to) {
        drawn.group.remove();
        this.arcs.delete(id);
        continue;
      }

      const arc = curve(from, to, geometry, this.nodeRadius);
      if (!arc) continue;

      for (const path of drawn.group.querySelectorAll('path')) path.setAttribute('d', arc.d);
      const label = drawn.group.querySelector('text');
      label?.setAttribute('x', String(arc.midX));
      label?.setAttribute('y', String(arc.midY - 6));
    }
  }

  clear(): void {
    for (const { group } of this.arcs.values()) group.remove();
    this.arcs.clear();
  }

  /**
   * El desvanecido y el borrado van por temporizador, no por el evento `finish`
   * de una animación: si la animación no corre, el arco se quedaría pegado en
   * la mesa para siempre.
   */
  private scheduleRemoval(id: string, group: SVGGElement, duration: number): void {
    setTimeout(() => group.classList.add('arco--saliendo'), duration + LINGER_MS);
    setTimeout(() => {
      group.remove();
      this.arcs.delete(id);
    }, duration + REMOVE_MS);
  }

  private playTravel(group: SVGGElement, line: SVGPathElement, d: string, duration: number): void {
    const length = line.getTotalLength();
    line.animate(
      [
        { strokeDasharray: `${length}`, strokeDashoffset: `${length}` },
        { strokeDasharray: `${length}`, strokeDashoffset: '0' },
      ],
      { duration, easing: 'cubic-bezier(.4,0,.2,1)' },
    );

    // Un tramo corto que recorre el arco por delante de la línea y marca el
    // sentido. Solo existe mientras dura; no deja rastro.
    const glint = svg('path', { class: 'arco__destello', attrs: { d } });
    // En reposo mide cero: si la animación no corre, no se ve nada raro.
    glint.style.strokeDasharray = '0 99999';
    group.insertBefore(glint, line.nextSibling);

    const travel = glint.animate(
      [
        { strokeDasharray: `${GLINT_LENGTH} ${length}`, strokeDashoffset: `${length + GLINT_LENGTH}` },
        { strokeDasharray: `${GLINT_LENGTH} ${length}`, strokeDashoffset: '0' },
      ],
      { duration: TIMING.destello, easing: 'ease-in-out' },
    );
    travel.addEventListener('finish', () => glint.remove());
  }
}

/**
 * La curva entre dos asientos, esquivando el tablero. Se abre siempre al mismo
 * lado respecto al sentido del trazo, así que ida y vuelta no se pisan.
 */
function curve(
  from: Seat,
  to: Seat,
  geometry: TableGeometry,
  nodeRadius: number,
): { d: string; midX: number; midY: number } | null {
  const bend = Math.min(70, Math.max(28, geometry.radius * 0.22));
  return arcBetween(from, to, nodeRadius + NODE_CLEARANCE, bend, {
    x: geometry.cx,
    y: geometry.cy,
    radius: geometry.tableRadius + BOARD_CLEARANCE,
  });
}
