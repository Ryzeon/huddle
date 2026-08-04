import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ExpandVocabularyUseCase } from './expand-vocabulary.js';
import type {
  RepoSnapshot,
  VocabularyExpanderPort,
  VocabularyStorePort,
} from '../ports/index.js';

const SNAPSHOT: RepoSnapshot = {
  repo: 'bo-back-ms-order-management',
  dirs: ['src/orders', 'src/billing'],
  summary: 'Microservicio de pedidos y facturación',
  keywords: ['spring-boot', 'kafka'],
};

class MemoryStore implements VocabularyStorePort {
  readonly saved = new Map<string, string[]>();
  read(key: string): string[] | null {
    return this.saved.get(key) ?? null;
  }
  write(key: string, terms: string[]): void {
    this.saved.set(key, terms);
  }
}

/** Motor de mentira: cuenta las llamadas y responde lo que se le diga. */
function expanderThat(
  behaviour: (snapshot: RepoSnapshot) => Promise<string[]>,
): VocabularyExpanderPort & { calls: number } {
  const fake = {
    calls: 0,
    expand(snapshot: RepoSnapshot): Promise<string[]> {
      fake.calls++;
      return behaviour(snapshot);
    },
  };
  return fake;
}

describe('ampliación del vocabulario', () => {
  let store: MemoryStore;

  const build = (expander: VocabularyExpanderPort, timeoutMs = 1_000): ExpandVocabularyUseCase =>
    new ExpandVocabularyUseCase({ expander, store }, { timeoutMs });

  beforeEach(() => {
    store = new MemoryStore();
  });

  test('suma los términos nuevos sin perder los del repositorio', async () => {
    const expander = expanderThat(async () => ['pedidos', 'facturacion', 'billing']);

    const terms = await build(expander).run(SNAPSHOT);

    assert.ok(terms.includes('spring-boot'), 'lo del manifiesto sigue');
    assert.ok(terms.includes('facturacion'), 'y ahora también el sinónimo');
    assert.ok(terms.includes('billing'), 'y su equivalente en inglés');
  });

  test('la segunda vez no gasta cuota: sale de disco', async () => {
    const expander = expanderThat(async () => ['pedidos']);
    const store2 = store;

    await build(expander).run(SNAPSHOT);
    const otraInstancia = new ExpandVocabularyUseCase(
      { expander, store: store2 },
      { timeoutMs: 1_000 },
    );
    const terms = await otraInstancia.run(SNAPSHOT);

    assert.equal(expander.calls, 1, 'reiniciar el daemon no debería volver a preguntar');
    assert.ok(terms.includes('pedidos'));
  });

  test('si cambia la descripción del repositorio, se vuelve a calcular', async () => {
    const expander = expanderThat(async () => ['pedidos']);
    const useCase = build(expander);

    await useCase.run(SNAPSHOT);
    await useCase.run({ ...SNAPSHOT, summary: 'Ahora también emite guías de remisión' });

    assert.equal(expander.calls, 2);
  });

  test('si el motor falla, se sigue con el vocabulario de siempre', async () => {
    const expander = expanderThat(async () => {
      throw new Error('claude no está instalado');
    });

    const terms = await build(expander).run(SNAPSHOT);

    assert.deepEqual(terms, ['spring-boot', 'kafka'], 'ni más ni menos que antes');
  });

  test('si el motor tarda demasiado, tampoco bloquea', async () => {
    // La promesa se deja colgada a propósito para provocar el corte, pero se
    // suelta al final: una promesa viva tras el test se lleva por delante al
    // resto del bloque cuando el runner cierra (pasó en CI, no en local).
    let soltar: (terminos: string[]) => void = () => undefined;
    const expander = expanderThat(() => new Promise<string[]>((resolve) => {
      soltar = resolve;
    }));

    const terms = await build(expander, 20).run(SNAPSHOT);
    soltar([]);

    assert.deepEqual(terms, ['spring-boot', 'kafka']);
  });

  test('un fallo no se cachea: el repositorio no se queda sin ampliar para siempre', async () => {
    let primeraVez = true;
    const expander = expanderThat(async () => {
      if (primeraVez) {
        primeraVez = false;
        throw new Error('caída pasajera');
      }
      return ['pedidos'];
    });
    const useCase = build(expander);

    await useCase.run(SNAPSHOT);
    const terms = await useCase.run(SNAPSHOT);

    assert.ok(terms.includes('pedidos'), 'al segundo intento debería ampliar');
  });

  test('una respuesta vacía tampoco se cachea', async () => {
    const expander = expanderThat(async () => []);
    const useCase = build(expander);

    await useCase.run(SNAPSHOT);
    await useCase.run(SNAPSHOT);

    assert.equal(expander.calls, 2);
    assert.equal(store.saved.size, 0);
  });

  test('un repositorio sin nada que decir tampoco revienta', async () => {
    const expander = expanderThat(async () => ['algo']);
    const desnudo: RepoSnapshot = { repo: 'suelto', dirs: [] };

    const terms = await build(expander).run(desnudo);

    assert.deepEqual(terms, ['algo']);
  });
});
