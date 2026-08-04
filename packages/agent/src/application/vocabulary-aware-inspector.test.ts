import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { VocabularyAwareInspector } from './vocabulary-aware-inspector.js';
import { ExpandVocabularyUseCase } from './use-cases/expand-vocabulary.js';
import type {
  RepoInspectorPort,
  RepoSnapshot,
  VocabularyExpanderPort,
  VocabularyStorePort,
} from './ports/index.js';

const SNAPSHOT: RepoSnapshot = {
  repo: 'orders',
  dirs: ['src/billing'],
  summary: 'Pedidos y facturación',
  keywords: ['kafka'],
  sha: 'a44512c',
};

class FakeInspector implements RepoInspectorPort {
  calls = 0;
  constructor(private readonly snap: RepoSnapshot = SNAPSHOT) {}
  snapshot(): RepoSnapshot {
    this.calls++;
    return this.snap;
  }
  currentSha(): string | undefined {
    return this.snap.sha;
  }
  currentBranch(): string | undefined {
    return 'main';
  }
}

const emptyStore = (): VocabularyStorePort => ({ read: () => null, write: () => undefined });

function build(
  expand: () => Promise<string[]>,
  inner = new FakeInspector(),
): { inspector: VocabularyAwareInspector; inner: FakeInspector } {
  const expander: VocabularyExpanderPort = { expand };
  const useCase = new ExpandVocabularyUseCase(
    { expander, store: emptyStore() },
    { timeoutMs: 500 },
  );
  return { inspector: new VocabularyAwareInspector(inner, useCase), inner };
}

describe('inspector que amplía el vocabulario', () => {
  test('la primera tarjeta sale sin esperar a nadie', () => {
    const { inspector } = build(() => new Promise(() => undefined));

    const card = inspector.snapshot();

    assert.deepEqual(card.keywords, ['kafka'], 'la de siempre, ya');
  });

  test('una vez ampliado, la tarjeta lo lleva', async () => {
    const { inspector } = build(async () => ['pedidos', 'billing']);

    await inspector.refresh();
    const card = inspector.snapshot();

    assert.ok(card.keywords?.includes('kafka'), 'sigue lo del manifiesto');
    assert.ok(card.keywords?.includes('billing'), 'y lo ampliado');
  });

  test('solo amplía una vez, aunque la tarjeta se pida en cada anuncio', async () => {
    let calls = 0;
    const { inspector } = build(async () => {
      calls++;
      return ['pedidos'];
    });

    await inspector.refresh();
    await inspector.refresh();
    inspector.snapshot();
    inspector.snapshot();

    assert.equal(calls, 1);
  });

  test('si la ampliación falla, la tarjeta sigue siendo la de siempre', async () => {
    const { inspector } = build(async () => {
      throw new Error('sin claude');
    });

    await inspector.refresh();

    assert.deepEqual(inspector.snapshot().keywords, ['kafka']);
  });

  test('el resto de la tarjeta pasa intacto', async () => {
    const { inspector } = build(async () => ['pedidos']);

    await inspector.refresh();
    const card = inspector.snapshot();

    assert.equal(card.repo, 'orders');
    assert.equal(card.sha, 'a44512c');
    assert.deepEqual(card.dirs, ['src/billing']);
  });

  test('el SHA y la rama los sigue dando el inspector de git', () => {
    const { inspector } = build(async () => []);

    assert.equal(inspector.currentSha(), 'a44512c');
    assert.equal(inspector.currentBranch(), 'main');
  });
});
