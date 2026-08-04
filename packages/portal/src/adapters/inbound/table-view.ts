/**
 * La mesa: un hexágono con la celda de la pregunta compartida en el centro y
 * los miembros repartidos alrededor.
 *
 * Al entrar alguien, su nodo traza un radio hacia la mesa que se queda como su
 * conexión. Al preguntar viaja un arco entre dos nodos, el de quien responde
 * late mientras piensa, y el arco vuelve al llegar la respuesta.
 *
 * La geometría viene entera de `domain/table-layout`; aquí solo hay SVG y
 * tiempos. Con `prefers-reduced-motion` los estados cambian de golpe, y siguen
 * distinguiéndose porque cada uno tiene trazo propio (continuo, discontinuo,
 * grosor) y no solo color.
 */

import type { Member } from '@huddle/protocol';
import type { Activity, SessionState } from '../../domain/session-state.js';
import { formatSeconds } from '../../domain/session-state.js';
import {
  arcBetween,
  memberLabel,
  placeSeats,
  polygonPoints,
  radiusFor,
  tableRadiusFor,
  type Seat,
  type TableGeometry,
} from '../../domain/table-layout.js';
import { agentGlyph, cellGlyph } from './brand.js';
import { clear, prefersReducedMotion, svg } from './dom.js';

const NODE_RADIUS = 26;
const TABLE_SIDES = 6;

/** Duraciones, en un solo sitio para poder afinarlas de una pasada. */
const TIMING = {
  entrada: 420,
  radio: 520,
  arcoIda: 900,
  arcoVuelta: 760,
  destello: 900,
  salida: 260,
};

interface Placed {
  seat: Seat;
  group: SVGGElement;
  spoke: SVGPathElement;
}

/**
 * Un arco vivo, con los extremos guardados por alias y no por coordenada. Con
 * coordenadas, al cambiar de tamaño la ventana los nodos se recolocan y el
 * arco se queda flotando donde estaban antes.
 */
interface DrawnArc {
  group: SVGGElement;
  from: string;
  to: string;
}

export interface TableViewOptions {
  /**
   * Fuerza el modo sin animación aunque el sistema no lo pida. Lo usa `?estatico=1`
   * para que las capturas sean deterministas: bajo tiempo virtual de Chrome el
   * reloj de animación no acompaña y el trazo saldría a medias.
   */
  sinAnimacion?: boolean;
}

export class TableView {
  private readonly root: SVGSVGElement;
  private readonly layerTable: SVGGElement;
  private readonly layerSpokes: SVGGElement;
  private readonly layerArcs: SVGGElement;
  private readonly layerNodes: SVGGElement;
  private readonly placed = new Map<string, Placed>();
  private readonly arcs = new Map<string, DrawnArc>();
  private geometry: TableGeometry = { cx: 0, cy: 0, radius: 0, nodeRadius: NODE_RADIUS, tableRadius: 0 };
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
    this.layerTable = svg('g', { class: 'capa capa--mesa' });
    this.layerSpokes = svg('g', { class: 'capa capa--radios' });
    this.layerArcs = svg('g', { class: 'capa capa--arcos' });
    this.layerNodes = svg('g', { class: 'capa capa--nodos' });
    this.root.append(this.layerTable, this.layerSpokes, this.layerArcs, this.layerNodes);
    this.host.appendChild(this.root);

    const observer = new ResizeObserver(() => this.measure());
    observer.observe(this.host);
    this.measure();
  }

  render(state: SessionState): void {
    this.state = state;
    if (this.width === 0) return;

    // Sin sala no hay mesa: el hueco lo ocupa el estado vacío, y una mesa
    // fantasma detrás de él solo estorba.
    if (state.room === null) {
      clear(this.layerTable);
      clear(this.layerSpokes);
      clear(this.layerNodes);
      clear(this.layerArcs);
      this.placed.clear();
      this.arcs.clear();
      return;
    }

    const members = state.members;
    this.geometry = this.computeGeometry(members.length);
    this.drawTable(state);

    const seats = placeSeats(members, this.geometry);
    const seen = new Set<string>();

    for (const seat of seats) {
      seen.add(seat.label);
      const member = members.find((m) => memberLabel(m) === seat.label);
      const existing = this.placed.get(seat.label);
      if (existing) {
        this.moveNode(existing, seat);
        this.decorate(existing.group, seat, member, state);
      } else {
        this.addNode(seat, member, state);
      }
    }

    for (const [label, placed] of [...this.placed]) {
      if (!seen.has(label)) this.removeNode(label, placed);
    }

    this.repositionArcs();
  }

  /** Dispara la animación de una pregunta o de su respuesta. */
  playActivity(activity: Activity): void {
    const from = this.seatFor(activity.from);
    const to = this.seatFor(activity.to);
    if (!from || !to) return;

    if (activity.phase === 'asking') {
      this.drawArc(`${activity.id}:ida`, from.seat, to.seat, 'pregunta', TIMING.arcoIda);
      return;
    }

    const tone = activity.phase === 'answered' ? 'respuesta' : 'fallo';
    this.fadeArc(`${activity.id}:ida`);
    this.drawArc(`${activity.id}:vuelta`, to.seat, from.seat, tone, TIMING.arcoVuelta, {
      label: labelFor(activity),
    });
  }

  // --- geometría ----------------------------------------------------------

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
    const cx = this.width / 2;
    const cy = this.height / 2;
    // Las etiquetas viven fuera del nodo, así que el radio se calcula sobre el
    // lado corto menos ese margen; si no, los alias se salen del lienzo.
    const available = Math.min(this.width, this.height) - NODE_RADIUS * 2 - 56;
    const radius = Math.min(
      radiusFor(Math.max(available, 120), memberCount),
      Math.max(90, available / 2),
    );
    return {
      cx,
      cy,
      radius,
      nodeRadius: NODE_RADIUS,
      tableRadius: tableRadiusFor(radius),
    };
  }

  // --- mesa ---------------------------------------------------------------

  private drawTable(state: SessionState): void {
    clear(this.layerTable);
    const { cx, cy, tableRadius } = this.geometry;


    this.layerTable.appendChild(
      svg('polygon', {
        class: 'mesa__tablero',
        attrs: { points: polygonPoints(cx, cy, tableRadius, TABLE_SIDES) },
      }),
    );
    this.layerTable.appendChild(
      svg('polygon', {
        class: 'mesa__tablero mesa__tablero--interior',
        attrs: { points: polygonPoints(cx, cy, tableRadius - 10, TABLE_SIDES) },
      }),
    );

    // En el centro va la celda y nada más. Es la pregunta compartida: el
    // código de sala ya vive en la cabecera y aquí solo estorbaría a los arcos.
    const center = svg('g', { attrs: { transform: `translate(${cx} ${cy})` } });
    const cell = cellGlyph(18);
    if (state.busy.length > 0) cell.classList.add('mesa__celda--activa');
    center.appendChild(cell);
    this.layerTable.appendChild(center);
  }

  // --- nodos --------------------------------------------------------------

  private addNode(seat: Seat, member: Member | undefined, state: SessionState): void {
    const group = svg('g', {
      class: 'nodo',
      attrs: { transform: `translate(${seat.x} ${seat.y})`, 'data-alias': seat.label },
    });

    // Dos grupos anidados a propósito: el de fuera solo posiciona (atributo
    // `transform`, jamás animado) y el de dentro es el que se anima. Animar el
    // mismo elemento que lleva el `translate` hace que la animación y el
    // atributo se peleen por la misma propiedad, y el nodo desaparece.
    const body = svg('g', { class: 'nodo__cuerpo' });
    body.appendChild(svg('circle', { class: 'nodo__latido', attrs: { r: NODE_RADIUS + 7 } }));
    body.appendChild(svg('circle', { class: 'nodo__disco', attrs: { r: NODE_RADIUS } }));
    body.appendChild(agentGlyph(NODE_RADIUS * 1.05));

    const labels = svg('g', { class: 'nodo__etiquetas' });
    body.appendChild(labels);
    group.appendChild(body);

    const spoke = svg('path', {
      class: 'radio',
      attrs: { d: spokePath(seat) },
    });
    this.layerSpokes.appendChild(spoke);
    this.layerNodes.appendChild(group);

    const placed: Placed = { seat, group, spoke };
    this.placed.set(seat.label, placed);
    this.decorate(group, seat, member, state);

    if (this.sinAnimacion()) return;

    // Regla en todo el archivo: el elemento se queda ya en su estado
    // final y la animación es solo el camino hasta él. Si el motor de
    // animación no arranca (una captura headless, una pestaña en segundo
    // plano), lo que se ve sigue siendo correcto en vez de quedar invisible.
    body.animate(
      [
        { opacity: 0, transform: 'scale(0.4)' },
        { opacity: 1, transform: 'scale(1)' },
      ],
      { duration: TIMING.entrada, easing: 'cubic-bezier(.2,.9,.25,1)' },
    );

    const length = spoke.getTotalLength();
    spoke.animate(
      [
        { strokeDasharray: `${length}`, strokeDashoffset: `${length}` },
        { strokeDasharray: `${length}`, strokeDashoffset: '0' },
      ],
      { duration: TIMING.radio, delay: TIMING.entrada * 0.5, easing: 'ease-out' },
    );
  }

  private moveNode(placed: Placed, seat: Seat): void {
    placed.seat = seat;
    placed.group.setAttribute('transform', `translate(${seat.x} ${seat.y})`);
    placed.spoke.setAttribute('d', spokePath(seat));
    placed.spoke.style.strokeDasharray = 'none';
  }

  private removeNode(label: string, placed: Placed): void {
    this.placed.delete(label);
    const done = (): void => {
      placed.group.remove();
      placed.spoke.remove();
    };
    if (this.sinAnimacion()) {
      done();
      return;
    }
    placed.group.classList.add('nodo--saliendo');
    placed.spoke.classList.add('radio--saliendo');
    setTimeout(done, TIMING.salida);
  }

  /** Etiquetas y estados. Se rehace entero: son cuatro nodos de texto. */
  private decorate(
    group: SVGGElement,
    seat: Seat,
    member: Member | undefined,
    state: SessionState,
  ): void {
    const labels = group.querySelector('.nodo__etiquetas');
    if (!labels) return;
    clear(labels);

    const isYou = state.you !== null && seat.label === state.you;
    const isHost = state.host !== null && seat.alias === state.host;
    const isBusy = state.busy.includes(seat.alias) || state.busy.includes(seat.label);
    const isViewer = member?.viewer === true;
    const offline = member?.status === 'offline';

    group.classList.toggle('nodo--tu', isYou);
    group.classList.toggle('nodo--anfitrion', isHost);
    group.classList.toggle('nodo--ocupado', isBusy);
    group.classList.toggle('nodo--espectador', isViewer);
    group.classList.toggle('nodo--ausente', offline);

    const above = seat.side === 'top';
    const baseY = above ? -NODE_RADIUS - 26 : NODE_RADIUS + 22;
    const step = above ? -15 : 15;

    labels.appendChild(
      svg('text', {
        class: 'nodo__alias',
        text: seat.alias,
        attrs: { y: baseY, 'text-anchor': 'middle' },
      }),
    );

    const detail = seat.tag ? `:${seat.tag}` : member?.card?.repo ?? '';
    if (detail) {
      labels.appendChild(
        svg('text', {
          class: 'nodo__tag',
          text: detail,
          attrs: { y: baseY + step, 'text-anchor': 'middle' },
        }),
      );
    }

    const marks: string[] = [];
    if (isHost) marks.push('◆ anfitrión');
    if (isViewer) marks.push('espectador');
    if (member && member.quotaRemaining !== null && member.quotaRemaining <= 5) {
      marks.push(`${member.quotaRemaining} de cuota`);
    }
    if (marks.length > 0) {
      labels.appendChild(
        svg('text', {
          class: 'nodo__marca',
          text: marks.join(' · '),
          attrs: { y: baseY + step * (detail ? 2 : 1), 'text-anchor': 'middle' },
        }),
      );
    }

    group.querySelector(':scope > title')?.remove();
    group.appendChild(
      svg('title', { text: `${seat.label}${isHost ? ' · anfitrión' : ''}${isBusy ? ' · respondiendo' : ''}` }),
    );
  }

  /** true cuando no hay que animar nada, por preferencia del sistema o por bandera. */
  private sinAnimacion(): boolean {
    return this.options.sinAnimacion === true || prefersReducedMotion();
  }

  private seatFor(alias: string): Placed | undefined {
    const exact = this.placed.get(alias);
    if (exact) return exact;
    // `@ana` debe encontrar a `@ana:facturacion` si es su único nodo.
    for (const [label, placed] of this.placed) {
      if (label.startsWith(`${alias}:`)) return placed;
    }
    return undefined;
  }

  // --- arcos --------------------------------------------------------------

  private drawArc(
    id: string,
    from: Seat,
    to: Seat,
    tone: 'pregunta' | 'respuesta' | 'fallo',
    duration: number,
    options: { label?: string | undefined } = {},
  ): void {
    // La curva se abre siempre al mismo lado respecto al sentido del trazo,
    // así que ida y vuelta no se pisan: se ven como dos carriles.
    const arc = this.arcFor(from, to);
    if (!arc) return;

    const group = svg('g', { class: `arco arco--${tone}`, attrs: { 'data-arco': id } });
    const line = svg('path', { class: 'arco__linea', attrs: { d: arc.d } });
    group.appendChild(line);
    this.arcs.set(id, { group, from: from.label, to: to.label });

    if (options.label) {
      group.appendChild(
        svg('text', {
          class: 'arco__etiqueta',
          text: options.label,
          attrs: { x: arc.midX, y: arc.midY - 6, 'text-anchor': 'middle' },
        }),
      );
    }
    this.layerArcs.appendChild(group);

    // El desvanecido y el borrado van por temporizador, no por el evento
    // `finish` de una animación: si la animación no corre, el arco se
    // quedaría pegado en la mesa para siempre.
    setTimeout(() => group.classList.add('arco--saliendo'), duration + 1400);
    setTimeout(() => {
      group.remove();
      this.arcs.delete(id);
    }, duration + 2100);

    if (this.sinAnimacion()) return;

    const length = line.getTotalLength();
    line.animate(
      [
        { strokeDasharray: `${length}`, strokeDashoffset: `${length}` },
        { strokeDasharray: `${length}`, strokeDashoffset: '0' },
      ],
      { duration, easing: 'cubic-bezier(.4,0,.2,1)' },
    );

    // El destello: un tramo corto que recorre el arco por delante de la línea
    // y marca el sentido. Solo existe mientras dura; no deja rastro.
    const glint = svg('path', { class: 'arco__destello', attrs: { d: arc.d } });
    // En reposo mide cero: si la animación no corre, no se ve nada raro.
    glint.style.strokeDasharray = '0 99999';
    group.insertBefore(glint, line.nextSibling);
    const travel = glint.animate(
      [
        { strokeDasharray: `22 ${length}`, strokeDashoffset: `${length + 22}` },
        { strokeDasharray: `22 ${length}`, strokeDashoffset: '0' },
      ],
      { duration: TIMING.destello, easing: 'ease-in-out' },
    );
    travel.addEventListener('finish', () => glint.remove());
  }

  private fadeArc(id: string): void {
    this.arcs.get(id)?.group.remove();
    this.arcs.delete(id);
  }

  /**
   * Recalcula los arcos vivos contra los asientos de ahora. Se llama en cada
   * render, que es también lo que ocurre al cambiar de tamaño la ventana.
   */
  private repositionArcs(): void {
    for (const [id, drawn] of [...this.arcs]) {
      const from = this.placed.get(drawn.from);
      const to = this.placed.get(drawn.to);
      if (!from || !to) {
        drawn.group.remove();
        this.arcs.delete(id);
        continue;
      }
      const arc = this.arcFor(from.seat, to.seat);
      if (!arc) continue;
      for (const path of drawn.group.querySelectorAll('path')) {
        path.setAttribute('d', arc.d);
      }
      const label = drawn.group.querySelector('text');
      if (label) {
        label.setAttribute('x', String(arc.midX));
        label.setAttribute('y', String(arc.midY - 6));
      }
    }
  }

  /** La curva entre dos asientos, esquivando la mesa. */
  private arcFor(from: Seat, to: Seat): { d: string; midX: number; midY: number } | null {
    const bend = Math.min(70, Math.max(28, this.geometry.radius * 0.22));
    return arcBetween(from, to, NODE_RADIUS + 4, bend, {
      x: this.geometry.cx,
      y: this.geometry.cy,
      // Un poco más que la mesa, para que el arco no la roce.
      radius: this.geometry.tableRadius + 16,
    });
  }
}

function spokePath(seat: Seat): string {
  return `M ${seat.spoke.x1} ${seat.spoke.y1} L ${seat.spoke.x2} ${seat.spoke.y2}`;
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
