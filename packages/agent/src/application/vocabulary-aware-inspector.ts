/**
 * Un inspector de repositorio que además amplía su vocabulario.
 *
 * Envuelve a otro `RepoInspectorPort` y le suma a la tarjeta los términos que
 * produce `ExpandVocabularyUseCase`. Va como decorador y no dentro del
 * inspector de git porque son dos cosas distintas: leer el repositorio es
 * síncrono y local, ampliar el vocabulario es una llamada a un motor que puede
 * tardar o fallar.
 *
 * `snapshot()` sigue siendo síncrono, que es lo que el puerto promete, y
 * devuelve lo que haya en ese momento: la primera llamada sale con la tarjeta
 * de siempre y dispara la ampliación en segundo plano; a partir de que
 * termine, sale ampliada. Como la tarjeta se reenvía en cada anuncio de
 * presencia, la sala se entera sola sin tener que esperar a nadie.
 */

import type { RepoInspectorPort, RepoSnapshot } from './ports/index.js';
import type { ExpandVocabularyUseCase } from './use-cases/expand-vocabulary.js';

export class VocabularyAwareInspector implements RepoInspectorPort {
  private terms: string[] = [];
  private started = false;

  constructor(
    private readonly inner: RepoInspectorPort,
    private readonly expand: ExpandVocabularyUseCase,
  ) {}

  snapshot(): RepoSnapshot {
    const base = this.inner.snapshot();
    if (!this.started) void this.refresh();
    return this.terms.length > 0 ? { ...base, keywords: this.terms } : base;
  }

  currentSha(): string | undefined {
    return this.inner.currentSha();
  }

  currentBranch(): string | undefined {
    return this.inner.currentBranch();
  }

  /**
   * Calcula el vocabulario una sola vez por proceso. `run` no lanza nunca, así
   * que aquí no hay nada que capturar; si no se pudo ampliar, devuelve el
   * vocabulario que ya había y `snapshot()` sigue sirviendo la tarjeta normal.
   */
  async refresh(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.terms = await this.expand.run(this.inner.snapshot());
  }
}
