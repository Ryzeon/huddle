/**
 * La mesa: un hexágono con la celda de la pregunta compartida en el centro y
 * los miembros repartidos alrededor.
 *
 * Esta clase solo coordina. Mide el lienzo, calcula la geometría y reparte el
 * trabajo entre las tres capas SVG, que son quienes saben dibujar: el tablero,
 * los nodos con sus radios, y los arcos de pregunta y respuesta.
 *
 * La geometría viene entera de `domain/table-layout`. Con
 * `prefers-reduced-motion` los estados cambian de golpe, y siguen
 * distinguiéndose porque cada uno tiene trazo propio y no solo color.
 */

import type { Activity, SessionState } from '../../domain/session-state.js';
import { formatSeconds } from '../../domain/session-state.js';
import {
  placeSeats,
  radiusFor,
  tableRadiusFor,
  type TableGeometry,
} from '../../domain/table-layout.js';
import { prefersReducedMotion, svg } from './dom.js';
import { ArcLayer, type ArcTone } from './table/arc-layer.js';
import { drawBoard } from './table/board.js';
import { NodeLayer } from './table/node-layer.js';
import { TIMING } from './table/timing.js';

const NODE_RADIUS = 26;

/** Margen que se reserva para las etiquetas, que viven fuera del nodo. */
const LABEL_MARGIN = 56;

const MIN_AVAILABLE = 120;
const MIN_RADIUS = 90;

export interface TableViewOptions {
  /**
   * Fuerza el modo sin animación aunque el sistema no lo pida. Lo usa
   * `?estatico=1` para que las capturas sean deterministas: bajo el tiempo
   * virtual de Chrome el reloj de animación no acompaña y el trazo saldría a
   * medias.
   */
  sinAnimacion?: boolean;
}

export class TableView {
  private readonly root: SVGSVGElement;
  private readonly boardLayer: SVGGElement;
  private readonly nodes: NodeLayer;
  private readonly arcs: ArcLayer;

  private geometry: TableGeometry = emptyGeometry();
  private state: SessionState | null = null;
  private width = 0;
  private height = 0;

  constructor(
    private readonly host: HTMLElement,
    private readonly options: TableViewOptions = {},
  ) {
    this.root = svg('svg', {
      class: 'mesa',
      attrs: { role: 'img', 'aria-label': 'mesa de la sala', focusable: 'false' },
    });

    this.boardLayer = svg('g', { class: 'capa capa--mesa' });
    const spokeLayer = svg('g', { class: 'capa capa--radios' });
    const arcLayer = svg('g', { class: 'capa capa--arcos' });
    const nodeLayer = svg('g', { class: 'capa capa--nodos' });
    this.root.append(this.boardLayer, spokeLayer, arcLayer, nodeLayer);
    this.host.appendChild(this.root);

    const animate = (): boolean => this.shouldAnimate();
    this.nodes = new NodeLayer(nodeLayer, spokeLayer, NODE_RADIUS, animate);
    this.arcs = new ArcLayer(arcLayer, NODE_RADIUS, animate);

    new ResizeObserver(() => this.measure()).observe(this.host);
    this.measure();
  }

  render(state: SessionState): void {
    this.state = state;
    if (this.width === 0) return;

    // Sin sala no hay mesa: el hueco lo ocupa el estado vacío, y una mesa
    // fantasma detrás de él solo estorba.
    if (state.room === null) {
      this.reset();
      return;
    }

    this.geometry = this.computeGeometry(state.members.length);
    drawBoard(this.boardLayer, this.geometry, state.busy.length > 0);
    this.nodes.sync(placeSeats(state.members, this.geometry), state);
    this.arcs.reposition(this.geometry, (label) => this.nodes.seatOf(label));
  }

  /** Dispara la animación de una pregunta o de su respuesta. */
  playActivity(activity: Activity): void {
    const from = this.nodes.find(activity.from);
    const to = this.nodes.find(activity.to);
    if (!from || !to) return;

    if (activity.phase === 'asking') {
      const id = arcId(activity.id, 'ida');
      this.arcs.draw(id, from.seat, to.seat, 'pregunta', TIMING.arcoIda, this.geometry);
      return;
    }

    const tone: ArcTone = activity.phase === 'answered' ? 'respuesta' : 'fallo';
    this.arcs.fade(arcId(activity.id, 'ida'));
    this.arcs.draw(
      arcId(activity.id, 'vuelta'),
      to.seat,
      from.seat,
      tone,
      TIMING.arcoVuelta,
      this.geometry,
      labelFor(activity),
    );
  }

  private reset(): void {
    this.boardLayer.replaceChildren();
    this.nodes.clear();
    this.arcs.clear();
  }

  private measure(): void {
    const rect = this.host.getBoundingClientRect();
    this.width = Math.max(0, Math.round(rect.width));
    this.height = Math.max(0, Math.round(rect.height));
    this.root.setAttribute('viewBox', `0 0 ${this.width} ${this.height}`);
    this.root.setAttribute('width', String(this.width));
    this.root.setAttribute('height', String(this.height));
    if (this.state) this.render(this.state);
  }

  private computeGeometry(memberCount: number): TableGeometry {
    // El radio se calcula sobre el lado corto menos el margen de las etiquetas;
    // si no, los alias se salen del lienzo.
    const available = Math.min(this.width, this.height) - NODE_RADIUS * 2 - LABEL_MARGIN;
    const radius = Math.min(
      radiusFor(Math.max(available, MIN_AVAILABLE), memberCount),
      Math.max(MIN_RADIUS, available / 2),
    );

    return {
      cx: this.width / 2,
      cy: this.height / 2,
      radius,
      nodeRadius: NODE_RADIUS,
      tableRadius: tableRadiusFor(radius),
    };
  }

  private shouldAnimate(): boolean {
    return this.options.sinAnimacion !== true && !prefersReducedMotion();
  }
}

function emptyGeometry(): TableGeometry {
  return { cx: 0, cy: 0, radius: 0, nodeRadius: NODE_RADIUS, tableRadius: 0 };
}

function arcId(activityId: string, direction: 'ida' | 'vuelta'): string {
  return `${activityId}:${direction}`;
}

/**
 * Lo que el arco de vuelta puede mostrar, sin el contenido de la respuesta:
 * `activity` no lo trae.
 */
function labelFor(activity: Activity): string | undefined {
  if (activity.phase === 'failed') return 'sin respuesta';
  if (activity.cached) return 'caché';
  return activity.elapsedMs !== undefined ? formatSeconds(activity.elapsedMs) : undefined;
}
