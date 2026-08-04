import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  arcBetween,
  memberLabel,
  orderSeats,
  placeSeats,
  polygonPoints,
  radiusFor,
  seatAngles,
  seatToSeatPath,
  sideOf,
  type TableGeometry,
} from './table-layout.js';

const GEOMETRY: TableGeometry = {
  cx: 400,
  cy: 300,
  radius: 200,
  nodeRadius: 26,
  tableRadius: 80,
};

describe('colocación alrededor de la mesa', () => {
  it('con un solo miembro lo sienta arriba del todo', () => {
    const [seat] = placeSeats([{ alias: '@ana' }], GEOMETRY);
    assert.equal(seat?.angleDeg, -90);
    assert.equal(seat?.x, 400);
    assert.equal(seat?.y, 100);
    assert.equal(seat?.side, 'top');
  });

  it('reparte cuatro miembros en los cuatro puntos cardinales', () => {
    const seats = placeSeats(
      [
        { alias: '@a', joinedAt: 1 },
        { alias: '@b', joinedAt: 2 },
        { alias: '@c', joinedAt: 3 },
        { alias: '@d', joinedAt: 4 },
      ],
      GEOMETRY,
    );
    assert.deepEqual(
      seats.map((s) => s.side),
      ['top', 'right', 'bottom', 'left'],
    );
    assert.deepEqual(
      seats.map((s) => s.textAnchor),
      ['middle', 'start', 'middle', 'end'],
    );
  });

  it('todos quedan exactamente sobre el círculo del radio pedido', () => {
    const seats = placeSeats(
      Array.from({ length: 7 }, (_, i) => ({ alias: `@m${i}`, joinedAt: i })),
      GEOMETRY,
    );
    for (const seat of seats) {
      const distance = Math.hypot(seat.x - GEOMETRY.cx, seat.y - GEOMETRY.cy);
      assert.ok(Math.abs(distance - GEOMETRY.radius) < 0.1, `${seat.alias} a ${distance}`);
    }
  });

  it('el radio va del borde de la mesa al borde del nodo, no de centro a centro', () => {
    const [seat] = placeSeats([{ alias: '@ana' }], GEOMETRY);
    assert.ok(seat);
    const inner = Math.hypot(seat.spoke.x1 - GEOMETRY.cx, seat.spoke.y1 - GEOMETRY.cy);
    const outer = Math.hypot(seat.spoke.x2 - GEOMETRY.cx, seat.spoke.y2 - GEOMETRY.cy);
    assert.ok(Math.abs(inner - GEOMETRY.tableRadius) < 0.1);
    assert.ok(Math.abs(outer - (GEOMETRY.radius - GEOMETRY.nodeRadius)) < 0.1);
  });

  it('el orden depende de cuándo entró cada uno, no del array que llega', () => {
    const members = [
      { alias: '@carla', joinedAt: 30 },
      { alias: '@ana', joinedAt: 10 },
      { alias: '@bruno', joinedAt: 20 },
    ];
    assert.deepEqual(
      orderSeats(members).map((m) => m.alias),
      ['@ana', '@bruno', '@carla'],
    );
    assert.deepEqual(
      orderSeats([...members].reverse()).map((m) => m.alias),
      ['@ana', '@bruno', '@carla'],
    );
  });

  it('sin joinedAt desempata por etiqueta, y los que lo traen van primero', () => {
    const ordered = orderSeats([
      { alias: '@zoe' },
      { alias: '@ana' },
      { alias: '@bruno', joinedAt: 99 },
    ]);
    assert.deepEqual(
      ordered.map((m) => m.alias),
      ['@bruno', '@ana', '@zoe'],
    );
  });

  it('dos repos de la misma persona son dos asientos distintos', () => {
    const seats = placeSeats(
      [
        { alias: '@ana', joinedAt: 1 },
        { alias: '@ana', tag: 'api', joinedAt: 2 },
      ],
      GEOMETRY,
    );
    assert.deepEqual(
      seats.map((s) => s.label),
      ['@ana', '@ana:api'],
    );
    // Con dos asientos quedan enfrentados: mismo eje vertical, lados opuestos.
    assert.notEqual(seats[0]?.y, seats[1]?.y);
    assert.deepEqual(seats.map((s) => s.side), ['top', 'bottom']);
  });

  it('memberLabel une alias y tag con dos puntos', () => {
    assert.equal(memberLabel({ alias: '@ana' }), '@ana');
    assert.equal(memberLabel({ alias: '@ana', tag: 'api' }), '@ana:api');
  });

  it('sin nadie no hay ángulos', () => {
    assert.deepEqual(seatAngles(0), []);
    assert.deepEqual(placeSeats([], GEOMETRY), []);
  });

  it('los ángulos suman una vuelta completa y arrancan arriba', () => {
    const angles = seatAngles(5);
    assert.equal(angles[0], -90);
    assert.equal(angles.length, 5);
    assert.equal(angles[4]! - angles[0]!, 288);
  });

  it('las diagonales se resuelven hacia el eje más cercano', () => {
    assert.equal(sideOf(-90), 'top');
    assert.equal(sideOf(0), 'right');
    assert.equal(sideOf(90), 'bottom');
    assert.equal(sideOf(180), 'left');
    assert.equal(sideOf(44), 'right');
    assert.equal(sideOf(46), 'bottom');
  });
});

describe('trazos entre asientos', () => {
  it('recorta el segmento por el radio del nodo en los dos extremos', () => {
    const path = seatToSeatPath({ x: 0, y: 0 }, { x: 100, y: 0 }, 10);
    assert.deepEqual(path, { x1: 10, y1: 0, x2: 90, y2: 0, length: 80 });
  });

  it('dos asientos demasiado juntos no dan trazo', () => {
    assert.equal(seatToSeatPath({ x: 0, y: 0 }, { x: 15, y: 0 }, 10), null);
    assert.equal(arcBetween({ x: 0, y: 0 }, { x: 15, y: 0 }, 10, 30), null);
  });

  it('el arco se curva y no pasa por el punto medio recto', () => {
    const arc = arcBetween({ x: 0, y: 0 }, { x: 200, y: 0 }, 10, 40);
    assert.ok(arc);
    assert.equal(arc.d, 'M 10 0 Q 100 40 190 0');
    assert.equal(arc.midX, 100);
    assert.notEqual(arc.midY, 0);
  });

  it('el arco esquiva la mesa cuando el trazo pasaría por encima', () => {
    // Dos asientos enfrentados: la recta entre ellos cruza el centro.
    const mesa = { x: 100, y: 0, radius: 60 };
    const recto = arcBetween({ x: 0, y: 0 }, { x: 200, y: 0 }, 10, 10);
    const esquivado = arcBetween({ x: 0, y: 0 }, { x: 200, y: 0 }, 10, 10, mesa);
    assert.ok(recto && esquivado);
    assert.ok(Math.abs(recto.midY) < mesa.radius, 'sin esquivar, la cima cae dentro');
    assert.ok(
      Math.hypot(esquivado.midX - mesa.x, esquivado.midY - mesa.y) >= mesa.radius - 0.01,
      `la cima quedó a ${Math.hypot(esquivado.midX - mesa.x, esquivado.midY - mesa.y)}`,
    );
  });

  it('si el trazo ya pasa lejos de la mesa, la curvatura no se toca', () => {
    const lejos = { x: 100, y: 400, radius: 60 };
    const conMesa = arcBetween({ x: 0, y: 0 }, { x: 200, y: 0 }, 10, 40, lejos);
    const sinMesa = arcBetween({ x: 0, y: 0 }, { x: 200, y: 0 }, 10, 40);
    assert.deepEqual(conMesa, sinMesa);
  });

  it('ida y vuelta se curvan a lados opuestos, así que no se pisan', () => {
    const ida = arcBetween({ x: 0, y: 0 }, { x: 200, y: 0 }, 10, 40);
    const vuelta = arcBetween({ x: 200, y: 0 }, { x: 0, y: 0 }, 10, 40);
    assert.ok(ida && vuelta);
    assert.equal(Math.sign(ida.midY), -Math.sign(vuelta.midY));
  });
});

describe('la mesa', () => {
  it('el hexágono tiene seis vértices y uno arriba', () => {
    const points = polygonPoints(100, 100, 50, 6).split(' ');
    assert.equal(points.length, 6);
    assert.equal(points[0], '100,50');
  });

  it('el radio crece con la gente pero nunca se sale de lo disponible', () => {
    assert.ok(radiusFor(400, 3) < radiusFor(400, 12));
    assert.ok(radiusFor(2000, 3) <= 264);
    assert.ok(radiusFor(100, 3) >= 96);
  });
});
