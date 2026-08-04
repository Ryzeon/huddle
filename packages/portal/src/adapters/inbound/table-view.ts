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
import { RosterSummary } from './table/roster-summary.js';
import { TIMING } from './table/timing.js';

const NODE_RADIUS = 26;

const LABEL_MARGIN = 56;

const MIN_AVAILABLE = 120;
const MIN_RADIUS = 90;

export interface TableViewOptions {
  /** Qué hacer al pulsar expulsar. Sin esto, el botón no se pinta. */
  onKick?: (label: string) => void;
  sinAnimacion?: boolean;
}

export class TableView {
  private readonly root: SVGSVGElement;
  private readonly boardLayer: SVGGElement;
  private readonly nodes: NodeLayer;
  private readonly arcs: ArcLayer;
  private readonly roster: RosterSummary;

  private geometry: TableGeometry = emptyGeometry();
  private state: SessionState | null = null;
  private width = 0;
  private height = 0;

  constructor(
    private readonly host: HTMLElement,
    private readonly options: TableViewOptions = {},
  ) {
    // El dibujo es decorativo: la misma informacion la da `RosterSummary` en
    // una lista que un lector de pantalla si puede recorrer.
    this.root = svg('svg', {
      class: 'mesa',
      attrs: { 'aria-hidden': 'true', focusable: 'false' },
    });

    this.boardLayer = svg('g', { class: 'capa capa--mesa' });
    const spokeLayer = svg('g', { class: 'capa capa--radios' });
    const arcLayer = svg('g', { class: 'capa capa--arcos' });
    const nodeLayer = svg('g', { class: 'capa capa--nodos' });
    this.root.append(this.boardLayer, spokeLayer, arcLayer, nodeLayer);
    this.host.appendChild(this.root);

    const animate = (): boolean => this.shouldAnimate();
    this.nodes = new NodeLayer(nodeLayer, spokeLayer, NODE_RADIUS, animate, options.onKick);
    this.arcs = new ArcLayer(arcLayer, NODE_RADIUS, animate);
    this.roster = new RosterSummary(this.host);

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
    const seats = placeSeats(state.members, this.geometry);

    drawBoard(this.boardLayer, this.geometry, state.busy.length > 0);
    this.nodes.sync(seats, state);
    this.arcs.reposition(this.geometry, (label) => this.nodes.seatOf(label));
    this.roster.update(seats, state);
  }

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
    this.roster.clear();
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

function labelFor(activity: Activity): string | undefined {
  if (activity.phase === 'failed') return 'sin respuesta';
  if (activity.cached) return 'caché';
  return activity.elapsedMs !== undefined ? formatSeconds(activity.elapsedMs) : undefined;
}
