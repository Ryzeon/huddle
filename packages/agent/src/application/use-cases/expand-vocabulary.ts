import {
  mergeVocabulary,
  parseTerms,
  vocabularyKey,
} from '../../domain/vocabulary.js';
import type {
  LoggerPort,
  RepoSnapshot,
  VocabularyExpanderPort,
  VocabularyStorePort,
} from '../ports/index.js';

export interface ExpandVocabularyDeps {
  expander: VocabularyExpanderPort;
  store: VocabularyStorePort;
  logger?: LoggerPort;
}

export interface ExpandVocabularyConfig {
  /**
   * Corte de reloj de pared. Es una mejora del ruteo, no una respuesta: si no
   * está a tiempo, el daemon ya lleva rato sirviendo con la tarjeta normal.
   */
  timeoutMs: number;
}

export class ExpandVocabularyUseCase {
  constructor(
    private readonly deps: ExpandVocabularyDeps,
    private readonly config: ExpandVocabularyConfig,
  ) {}

  async run(snapshot: RepoSnapshot): Promise<string[]> {
    const base = snapshot.keywords ?? [];
    const key = vocabularyKey(snapshot);

    const cached = this.deps.store.read(key);
    if (cached) return mergeVocabulary(base, cached);

    let extra: string[];
    try {
      extra = parseTerms(await this.withTimeout(this.deps.expander.expand(snapshot)));
    } catch (error) {
      this.deps.logger?.warn(
        `no se pudo ampliar el vocabulario de ${snapshot.repo}: ${message(error)}`,
      );
      return mergeVocabulary(base, []);
    }

    // Una lista vacía no se guarda: sería cachear un fallo silencioso y el
    // repositorio se quedaría sin ampliar hasta que cambiara su descripción.
    if (extra.length > 0) this.deps.store.write(key, extra);

    return mergeVocabulary(base, extra);
  }

  private withTimeout<T>(work: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      // Sin `unref`: un temporizador que no sujeta el bucle deja que el proceso
      // se vacíe mientras aún hay trabajo, y el runner de tests cancelaba los
      // casos siguientes del bloque. El `clearTimeout` ya evita que se quede
      // colgado, que era lo que `unref` pretendía resolver.
      const timer = setTimeout(
        () => reject(new Error(`agotados los ${this.config.timeoutMs} ms`)),
        this.config.timeoutMs,
      );
      work.then(resolve, reject).finally(() => clearTimeout(timer));
    });
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
