import type { Member } from '@huddle/protocol';
import type { SessionState } from '../../../domain/session-state.js';
import { memberLabel, type Seat } from '../../../domain/table-layout.js';
import { agentGlyph } from '../brand.js';
import { clear, svg } from '../dom.js';
import { TIMING, type ShouldAnimate } from './timing.js';

const LOW_QUOTA = 5;

/** Cuánto se queda el botón pidiendo confirmación antes de volver a su sitio. */
const CONFIRM_MS = 3_000;

export type OnKick = (label: string) => void;

export interface PlacedNode {
  seat: Seat;
  group: SVGGElement;
  spoke: SVGPathElement;
}

export class NodeLayer {
  private readonly placed = new Map<string, PlacedNode>();

  constructor(
    private readonly nodes: SVGGElement,
    private readonly spokes: SVGGElement,
    private readonly nodeRadius: number,
    private readonly shouldAnimate: ShouldAnimate,
    private readonly onKick?: OnKick,
  ) {}

  sync(seats: readonly Seat[], state: SessionState): void {
    const seen = new Set<string>();

    for (const seat of seats) {
      seen.add(seat.label);
      const member = state.members.find((candidate) => memberLabel(candidate) === seat.label);
      const existing = this.placed.get(seat.label);
      if (existing) {
        this.move(existing, seat);
        this.decorate(existing.group, seat, member, state);
      } else {
        this.add(seat, member, state);
      }
    }

    for (const [label, node] of [...this.placed]) {
      if (!seen.has(label)) this.remove(label, node);
    }
  }

  find(alias: string): PlacedNode | undefined {
    const exact = this.placed.get(alias);
    if (exact) return exact;
    for (const [label, node] of this.placed) {
      if (label.startsWith(`${alias}:`)) return node;
    }
    return undefined;
  }

  seatOf(label: string): Seat | undefined {
    return this.placed.get(label)?.seat;
  }

  clear(): void {
    clear(this.nodes);
    clear(this.spokes);
    this.placed.clear();
  }

  private add(seat: Seat, member: Member | undefined, state: SessionState): void {
    const group = svg('g', {
      class: 'nodo',
      attrs: { transform: translate(seat), 'data-alias': seat.label },
    });

    // Dos grupos anidados a propósito: el de fuera solo posiciona (atributo
    // `transform`, jamás animado) y el de dentro es el que se anima. Animar el
    // mismo elemento que lleva el `translate` hace que la animación y el
    // atributo se peleen por la misma propiedad, y el nodo desaparece.
    const body = svg('g', { class: 'nodo__cuerpo' });
    body.appendChild(svg('circle', { class: 'nodo__latido', attrs: { r: this.nodeRadius + 7 } }));
    body.appendChild(svg('circle', { class: 'nodo__disco', attrs: { r: this.nodeRadius } }));
    body.appendChild(agentGlyph(this.nodeRadius * 1.05));
    body.appendChild(svg('g', { class: 'nodo__etiquetas' }));
    group.appendChild(body);

    const spoke = svg('path', { class: 'radio', attrs: { d: spokePath(seat) } });
    this.spokes.appendChild(spoke);
    this.nodes.appendChild(group);

    this.placed.set(seat.label, { seat, group, spoke });
    this.decorate(group, seat, member, state);

    if (this.shouldAnimate()) this.playEntrance(body, spoke);
  }

  /**
   * El elemento se queda ya en su estado final y la animación es solo el camino
   * hasta él. Si el motor no arranca (captura headless, pestaña en segundo
   * plano), lo que se ve sigue siendo correcto en vez de quedar invisible.
   */
  private playEntrance(body: SVGGElement, spoke: SVGPathElement): void {
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

  private move(node: PlacedNode, seat: Seat): void {
    node.seat = seat;
    node.group.setAttribute('transform', translate(seat));
    node.spoke.setAttribute('d', spokePath(seat));
    node.spoke.style.strokeDasharray = 'none';
  }

  private remove(label: string, node: PlacedNode): void {
    this.placed.delete(label);
    const done = (): void => {
      node.group.remove();
      node.spoke.remove();
    };

    if (!this.shouldAnimate()) {
      done();
      return;
    }
    node.group.classList.add('nodo--saliendo');
    node.spoke.classList.add('radio--saliendo');
    setTimeout(done, TIMING.salida);
  }

  private decorate(
    group: SVGGElement,
    seat: Seat,
    member: Member | undefined,
    state: SessionState,
  ): void {
    const labels = group.querySelector('.nodo__etiquetas');
    if (!labels) return;

    const marks = readMarks(seat, member, state);
    applyStateClasses(group, marks);

    clear(labels);
    this.renderLabels(labels, seat, member, marks);

    // Solo el anfitrión expulsa, y a sí mismo no: el hub lo rechazaría, y
    // ofrecer un botón que no puede funcionar es peor que no ofrecerlo.
    const puedeExpulsar =
      this.onKick !== undefined &&
      state.host !== null &&
      state.you !== null &&
      state.host === state.you.split(':')[0] &&
      seat.alias !== state.host;

    group.querySelector('.nodo__expulsar')?.remove();
    if (puedeExpulsar) group.appendChild(this.kickButton(seat));

    group.querySelector(':scope > title')?.remove();
    group.appendChild(svg('title', { text: titleFor(seat, marks) }));
  }

  /**
   * Dos toques: el primero pide confirmación y el segundo expulsa. Un solo
   * clic para echar a alguien de la sala es demasiado fácil de dar sin querer,
   * y un `confirm()` del navegador bloquea toda la página.
   */
  private kickButton(seat: Seat): SVGGElement {
    const boton = svg('g', {
      class: 'nodo__expulsar',
      attrs: {
        role: 'button',
        tabindex: '0',
        transform: `translate(${this.nodeRadius - 4} ${-this.nodeRadius + 4})`,
      },
    });
    boton.appendChild(svg('circle', { class: 'nodo__expulsar-fondo', attrs: { r: 9 } }));
    const glifo = svg('text', {
      class: 'nodo__expulsar-glifo',
      text: '×',
      attrs: { 'text-anchor': 'middle', y: 4 },
    });
    boton.appendChild(glifo);
    boton.appendChild(svg('title', { text: `expulsar a ${seat.label}` }));

    let armado = false;
    let volver: ReturnType<typeof setTimeout> | undefined;

    const activar = (event: Event): void => {
      event.stopPropagation();
      event.preventDefault();

      if (armado) {
        clearTimeout(volver);
        this.onKick?.(seat.label);
        return;
      }

      armado = true;
      boton.classList.add('nodo__expulsar--armado');
      glifo.textContent = '¿?';
      volver = setTimeout(() => {
        armado = false;
        boton.classList.remove('nodo__expulsar--armado');
        glifo.textContent = '×';
      }, CONFIRM_MS);
    };

    boton.addEventListener('click', activar);
    boton.addEventListener('keydown', (event) => {
      const key = (event as KeyboardEvent).key;
      if (key === 'Enter' || key === ' ') activar(event);
    });

    return boton;
  }

  private renderLabels(
    labels: Element,
    seat: Seat,
    member: Member | undefined,
    marks: NodeMarks,
  ): void {
    // Arriba de la mesa las etiquetas crecen hacia arriba, y al revés abajo:
    // así nunca invaden el tablero.
    const above = seat.side === 'top';
    const baseY = above ? -this.nodeRadius - 26 : this.nodeRadius + 22;
    const step = above ? -15 : 15;

    labels.appendChild(text('nodo__alias', seat.alias, baseY));

    const detail = seat.tag ? `:${seat.tag}` : member?.card?.repo ?? '';
    if (detail) labels.appendChild(text('nodo__tag', detail, baseY + step));

    const badges = badgesFor(member, marks);
    if (badges.length > 0) {
      const y = baseY + step * (detail ? 2 : 1);
      labels.appendChild(text('nodo__marca', badges.join(' · '), y));
    }
  }
}

interface NodeMarks {
  you: boolean;
  host: boolean;
  busy: boolean;
  viewer: boolean;
  offline: boolean;
}

function readMarks(seat: Seat, member: Member | undefined, state: SessionState): NodeMarks {
  return {
    you: state.you !== null && seat.label === state.you,
    host: state.host !== null && seat.alias === state.host,
    busy: state.busy.includes(seat.alias) || state.busy.includes(seat.label),
    viewer: member?.viewer === true,
    offline: member?.status === 'offline',
  };
}

function applyStateClasses(group: SVGGElement, marks: NodeMarks): void {
  group.classList.toggle('nodo--tu', marks.you);
  group.classList.toggle('nodo--anfitrion', marks.host);
  group.classList.toggle('nodo--ocupado', marks.busy);
  group.classList.toggle('nodo--espectador', marks.viewer);
  group.classList.toggle('nodo--ausente', marks.offline);
}

function badgesFor(member: Member | undefined, marks: NodeMarks): string[] {
  const badges: string[] = [];
  if (marks.host) badges.push('◆ anfitrión');
  if (marks.viewer) badges.push('espectador');
  if (member && member.quotaRemaining !== null && member.quotaRemaining <= LOW_QUOTA) {
    badges.push(`${member.quotaRemaining} de cuota`);
  }
  return badges;
}

function titleFor(seat: Seat, marks: NodeMarks): string {
  const extra = [marks.host ? 'anfitrión' : '', marks.busy ? 'respondiendo' : ''].filter(Boolean);
  return [seat.label, ...extra].join(' · ');
}

function text(className: string, content: string, y: number): SVGElement {
  return svg('text', { class: className, text: content, attrs: { y, 'text-anchor': 'middle' } });
}

function translate(seat: Seat): string {
  return `translate(${seat.x} ${seat.y})`;
}

function spokePath(seat: Seat): string {
  return `M ${seat.spoke.x1} ${seat.spoke.y1} L ${seat.spoke.x2} ${seat.spoke.y2}`;
}
