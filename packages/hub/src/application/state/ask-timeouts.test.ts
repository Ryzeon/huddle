import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { AskTimeouts } from './ask-timeouts.js';
import type { TimerPort } from '../ports/member-channel.js';

/** Temporizadores manuales: los tests deciden cuándo pasa el tiempo. */
class ManualTimers implements TimerPort {
  private readonly tasks: { at: number; task: () => void; cancelled: boolean }[] = [];
  now = 0;

  schedule(delayMs: number, task: () => void): () => void {
    const entry = { at: this.now + delayMs, task, cancelled: false };
    this.tasks.push(entry);
    return () => {
      entry.cancelled = true;
    };
  }

  advance(ms: number): void {
    this.now += ms;
    for (const entry of this.tasks) {
      if (!entry.cancelled && entry.at <= this.now) {
        entry.cancelled = true;
        entry.task();
      }
    }
  }
}

describe('AskTimeouts', () => {
  test('dispara al vencer el plazo', () => {
    const timers = new ManualTimers();
    const timeouts = new AskTimeouts(timers);
    let fired = false;

    timeouts.schedule('q1', 1000, () => {
      fired = true;
    });
    timers.advance(1000);

    assert.equal(fired, true);
  });

  test('cancelar impide que dispare', () => {
    const timers = new ManualTimers();
    const timeouts = new AskTimeouts(timers);
    let fired = false;

    timeouts.schedule('q1', 1000, () => {
      fired = true;
    });
    timeouts.cancel('q1');
    timers.advance(5000);

    assert.equal(fired, false, 'una respuesta a tiempo no debe producir además un timeout');
  });

  test('se olvida del temporizador después de disparar', () => {
    const timers = new ManualTimers();
    const timeouts = new AskTimeouts(timers);

    timeouts.schedule('q1', 1000, () => {});
    assert.equal(timeouts.size, 1);

    timers.advance(1000);
    assert.equal(timeouts.size, 0, 'si no, la tabla crece sin límite');
  });

  test('reprogramar el mismo id no deja dos vivos', () => {
    const timers = new ManualTimers();
    const timeouts = new AskTimeouts(timers);
    let fires = 0;

    timeouts.schedule('q1', 1000, () => {
      fires += 1;
    });
    timeouts.schedule('q1', 1000, () => {
      fires += 1;
    });
    timers.advance(2000);

    assert.equal(fires, 1);
    assert.equal(timeouts.size, 0);
  });

  test('cancelar un id desconocido no explota', () => {
    const timeouts = new AskTimeouts(new ManualTimers());
    assert.doesNotThrow(() => timeouts.cancel('inexistente'));
  });
});
