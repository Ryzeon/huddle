/**
 * El guion no es solo atrezo: es el único banco de pruebas de la sesión
 * completa mientras el hub no manda `activity`. Si deja de contar una historia
 * coherente, las animaciones se ajustan sobre algo que no pasa.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEMO_ROOM, DEMO_SCRIPT, DEMO_YOU, scriptDuration } from './demo-script.js';
import { initialState, reduce, type SessionState } from '../../domain/session-state.js';
import { memberLabel } from '../../domain/table-layout.js';

function playUntil(untilMs = Number.POSITIVE_INFINITY): SessionState {
  return DEMO_SCRIPT.filter((item) => item.at <= untilMs).reduce(
    (state, item) => reduce(state, item.event, item.at),
    initialState(),
  );
}

describe('guion de demostración', () => {
  it('los eventos van en orden creciente de tiempo', () => {
    for (let i = 1; i < DEMO_SCRIPT.length; i++) {
      assert.ok(
        DEMO_SCRIPT[i]!.at >= DEMO_SCRIPT[i - 1]!.at,
        `el evento ${i} va hacia atrás en el tiempo`,
      );
    }
  });

  it('dura poco más de veinte segundos: se puede mirar entero', () => {
    const total = scriptDuration();
    assert.ok(total > 15_000 && total < 30_000, `dura ${total} ms`);
  });

  it('cada actividad abre con «asking» y cierra en una sola fase final', () => {
    const opened = new Set<string>();
    const closed = new Set<string>();
    for (const { event } of DEMO_SCRIPT) {
      if (event.t !== 'activity') continue;
      if (event.phase === 'asking') {
        assert.ok(!opened.has(event.id), `${event.id} se abre dos veces`);
        opened.add(event.id);
      } else {
        assert.ok(opened.has(event.id), `${event.id} cierra sin haberse abierto`);
        assert.ok(!closed.has(event.id), `${event.id} cierra dos veces`);
        closed.add(event.id);
      }
    }
    assert.deepEqual([...opened], [...closed], 'toda pregunta acaba resolviéndose');
    assert.ok(opened.size >= 3, 'hacen falta varias preguntas para ver las animaciones');
  });

  it('nadie se pregunta a sí mismo', () => {
    for (const { event } of DEMO_SCRIPT) {
      if (event.t === 'activity') assert.notEqual(event.from, event.to);
    }
  });

  it('enseña las tres fases: respondida, de caché y fallida', () => {
    const phases = DEMO_SCRIPT.flatMap(({ event }) =>
      event.t === 'activity' ? [event.phase] : [],
    );
    assert.ok(phases.includes('answered'));
    assert.ok(phases.includes('failed'));
    assert.ok(
      DEMO_SCRIPT.some(({ event }) => event.t === 'activity' && event.cached === true),
      'falta un acierto de caché, que es el argumento del producto',
    );
  });

  it('reproducido entero deja la sala en un estado coherente', () => {
    const state = playUntil();
    assert.equal(state.room, DEMO_ROOM);
    assert.equal(state.you, DEMO_YOU);
    assert.equal(state.host, '@bruno', 'el mando cambió al irse la anfitriona');
    assert.deepEqual(state.busy, [], 'no queda nadie colgado respondiendo');
    assert.deepEqual(
      state.members.map(memberLabel).sort(),
      ['@bruno:api', '@carla:facturacion', DEMO_YOU].sort(),
    );
  });

  it('cuenta las cuatro cosas que el chat tiene que saber mostrar', () => {
    const kinds = new Set(playUntil().entries.map((entry) => entry.kind));
    for (const kind of ['joined', 'left', 'host', 'message', 'ask', 'answer', 'failed']) {
      assert.ok(kinds.has(kind as never), `el guion nunca produce una entrada «${kind}»`);
    }
  });

  it('a mitad de guion hay alguien pensando, que es lo que anima la mesa', () => {
    const state = playUntil(12_000);
    assert.deepEqual(state.busy, ['@ana']);
    assert.equal(state.members.length, 4);
  });
});
