/**
 * Colocación de los miembros alrededor de la mesa. Entra una lista de miembros
 * y salen coordenadas; no sabe nada de SVG, de animaciones ni del DOM.
 *
 * Dos propiedades importan más que la fórmula:
 *
 * - Estabilidad: el mismo conjunto de miembros da siempre los mismos asientos,
 *   en el mismo orden. Si el orden bailara, cada `room_state` movería a todo
 *   el mundo de sitio y la mesa sería ilegible.
 * - Reparto: los asientos ocupan el círculo completo, empezando arriba y
 *   girando en el sentido del reloj.
 */

/** Lo mínimo que hace falta saber de alguien para sentarlo. */
export interface Seatable {
  alias: string;
  tag?: string;
  /** Epoch ms de entrada. Decide el orden; sin él, va al final. */
  joinedAt?: number;
}

export interface TableGeometry {
  /** Centro de la mesa. */
  cx: number;
  cy: number;
  /** Distancia del centro al centro de cada nodo. */
  radius: number;
  /** Radio del nodo, para recortar la línea y que no le entre por debajo. */
  nodeRadius: number;
  /** Radio de la mesa, para que la línea arranque en su borde y no en el centro. */
  tableRadius: number;
}

/** De qué lado de la mesa cae un asiento. Decide dónde va su etiqueta. */
export type Side = 'top' | 'right' | 'bottom' | 'left';

export interface Seat {
  alias: string;
  tag?: string;
  /** Identidad completa en la sala: `@ana` o `@ana:facturacion`. */
  label: string;
  index: number;
  /** Grados, 0 = derecha, creciendo en el sentido del reloj (coords de pantalla). */
  angleDeg: number;
  x: number;
  y: number;
  side: Side;
  /** Anclaje del texto para que las etiquetas no se metan en la mesa. */
  textAnchor: 'start' | 'middle' | 'end';
  /** Segmento entre el borde de la mesa y el borde del nodo. */
  spoke: { x1: number; y1: number; x2: number; y2: number };
}

/** Etiqueta canónica de un miembro: `@ana` o `@ana:api`. */
export function memberLabel(member: Seatable): string {
  return member.tag ? `${member.alias}:${member.tag}` : member.alias;
}

/**
 * Orden estable: primero quien lleva más tiempo, y a igualdad de instante
 * (o sin instante), por etiqueta. Nunca depende del orden de llegada del
 * array, que el hub no garantiza.
 */
export function orderSeats<T extends Seatable>(members: readonly T[]): T[] {
  return [...members].sort((a, b) => {
    const at = a.joinedAt ?? Number.MAX_SAFE_INTEGER;
    const bt = b.joinedAt ?? Number.MAX_SAFE_INTEGER;
    if (at !== bt) return at - bt;
    return memberLabel(a).localeCompare(memberLabel(b));
  });
}

/**
 * Ángulos repartidos por igual, empezando arriba (-90°) y girando en el
 * sentido del reloj. Con un solo miembro, queda arriba del todo.
 */
export function seatAngles(count: number): number[] {
  if (count <= 0) return [];
  const step = 360 / count;
  return Array.from({ length: count }, (_, i) => -90 + i * step);
}

/** El lado al que mira un ángulo, con las diagonales resueltas hacia el eje X. */
export function sideOf(angleDeg: number): Side {
  const a = ((angleDeg % 360) + 360) % 360;
  if (a >= 315 || a < 45) return 'right';
  if (a < 135) return 'bottom';
  if (a < 225) return 'left';
  return 'top';
}

function anchorFor(side: Side): 'start' | 'middle' | 'end' {
  if (side === 'right') return 'start';
  if (side === 'left') return 'end';
  return 'middle';
}

/**
 * Sienta a todos alrededor de la mesa.
 *
 * El `spoke` es la línea que en la interfaz se dibuja al entrar: va del borde
 * de la mesa al borde del nodo, nunca de centro a centro, para que ni la mesa
 * ni el icono se la coman.
 */
export function placeSeats(
  members: readonly Seatable[],
  geometry: TableGeometry,
): Seat[] {
  const ordered = orderSeats(members);
  const angles = seatAngles(ordered.length);

  return ordered.map((member, index) => {
    const angleDeg = angles[index] ?? -90;
    const rad = (angleDeg * Math.PI) / 180;
    const dx = Math.cos(rad);
    const dy = Math.sin(rad);
    const x = geometry.cx + dx * geometry.radius;
    const y = geometry.cy + dy * geometry.radius;
    const side = sideOf(angleDeg);

    const seat: Seat = {
      alias: member.alias,
      label: memberLabel(member),
      index,
      angleDeg,
      x: round(x),
      y: round(y),
      side,
      textAnchor: anchorFor(side),
      spoke: {
        x1: round(geometry.cx + dx * geometry.tableRadius),
        y1: round(geometry.cy + dy * geometry.tableRadius),
        x2: round(geometry.cx + dx * (geometry.radius - geometry.nodeRadius)),
        y2: round(geometry.cy + dy * (geometry.radius - geometry.nodeRadius)),
      },
    };
    if (member.tag !== undefined) seat.tag = member.tag;
    return seat;
  });
}

/**
 * Segmento entre dos asientos, recortado en ambos extremos por el radio del
 * nodo. Es el trazo que viaja cuando alguien pregunta.
 *
 * Devuelve `null` si los asientos coinciden: no hay flecha que dibujar.
 */
export function seatToSeatPath(
  from: { x: number; y: number },
  to: { x: number; y: number },
  nodeRadius: number,
): { x1: number; y1: number; x2: number; y2: number; length: number } | null {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  if (distance <= nodeRadius * 2) return null;

  const ux = dx / distance;
  const uy = dy / distance;
  return {
    x1: round(from.x + ux * nodeRadius),
    y1: round(from.y + uy * nodeRadius),
    x2: round(to.x - ux * nodeRadius),
    y2: round(to.y - uy * nodeRadius),
    length: round(distance - nodeRadius * 2),
  };
}

/**
 * Curva que evita el centro de la mesa: una cuadrática cuyo control se
 * desplaza perpendicular al segmento. Sin esto, cualquier pregunta entre dos
 * asientos opuestos pasa por encima de la mesa y se pierde.
 */
export function arcBetween(
  from: { x: number; y: number },
  to: { x: number; y: number },
  nodeRadius: number,
  bend: number,
  /** Zona por la que el arco no debe pasar: la mesa. */
  avoid?: { x: number; y: number; radius: number },
): { d: string; midX: number; midY: number } | null {
  const segment = seatToSeatPath(from, to, nodeRadius);
  if (!segment) return null;

  const dx = segment.x2 - segment.x1;
  const dy = segment.y2 - segment.y1;
  const midX = (segment.x1 + segment.x2) / 2;
  const midY = (segment.y1 + segment.y2) / 2;
  // Perpendicular normalizada: el arco siempre se abre al mismo lado respecto
  // al sentido del trazo, así que la ida y la vuelta se ven como dos carriles.
  const length = Math.hypot(dx, dy) || 1;
  const px = -dy / length;
  const py = dx / length;

  const effective = avoid
    ? Math.max(bend, bendToClear({ x: midX, y: midY }, { x: px, y: py }, avoid))
    : bend;

  const cx = round(midX + px * effective);
  const cy = round(midY + py * effective);

  return {
    d: `M ${segment.x1} ${segment.y1} Q ${cx} ${cy} ${segment.x2} ${segment.y2}`,
    // Punto de la curva en t=0.5, donde se pone la etiqueta.
    midX: round(0.25 * segment.x1 + 0.5 * cx + 0.25 * segment.x2),
    midY: round(0.25 * segment.y1 + 0.5 * cy + 0.25 * segment.y2),
  };
}

/**
 * Cuánto hay que curvar para que la cima del arco quede fuera de la mesa. Sin
 * esto, una pregunta entre dos asientos enfrentados cruza el tablero por
 * encima de la celda y se pierde entre las líneas.
 *
 * La cima de una cuadrática está en `medio + perpendicular · (curvatura / 2)`,
 * así que basta resolver dónde sale del círculo de la mesa.
 */
export function bendToClear(
  mid: { x: number; y: number },
  perpendicular: { x: number; y: number },
  avoid: { x: number; y: number; radius: number },
): number {
  const vx = mid.x - avoid.x;
  const vy = mid.y - avoid.y;
  const squared = vx * vx + vy * vy;
  // Si el punto medio ya cae fuera de la mesa, el trazo no la cruza por el
  // centro y no hay nada que corregir. Sin esta guarda, la ecuación devuelve
  // la *otra* salida del círculo y manda el arco a dar la vuelta entera.
  if (squared >= avoid.radius * avoid.radius) return 0;

  const along = vx * perpendicular.x + vy * perpendicular.y;
  const apex = -along + Math.sqrt(along * along - squared + avoid.radius * avoid.radius);
  return apex > 0 ? apex * 2 : 0;
}

/**
 * Vértices de un polígono regular centrado, con un vértice arriba.
 * La mesa es un hexágono; esto es lo único que necesita para dibujarse.
 */
export function polygonPoints(cx: number, cy: number, radius: number, sides: number): string {
  const points: string[] = [];
  for (let i = 0; i < sides; i++) {
    const angle = (-90 + (360 / sides) * i) * (Math.PI / 180);
    points.push(`${round(cx + Math.cos(angle) * radius)},${round(cy + Math.sin(angle) * radius)}`);
  }
  return points.join(' ');
}

/**
 * Radio de la mesa en función del espacio disponible y de cuánta gente hay.
 * Con mucha gente los nodos necesitan más perímetro o se solapan.
 */
export function radiusFor(available: number, memberCount: number): number {
  const base = Math.min(available * 0.42, 264);
  const crowding = memberCount > 6 ? (memberCount - 6) * 7 : 0;
  return Math.max(96, base + Math.min(crowding, 56));
}

/** Radio de la mesa: proporcional al corro, pero acotado por los dos lados. */
export function tableRadiusFor(seatRadius: number): number {
  return Math.min(126, Math.max(56, seatRadius * 0.46));
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
