/**
 * Amplía el vocabulario de un repositorio para que `@auto` lo encuentre.
 *
 * Sin esto, `@auto` solo acierta cuando quien pregunta usa las mismas palabras
 * que el repositorio: preguntar por «facturación» no da con un repo cuyo
 * README dice «billing». La ampliación pide sinónimos y equivalentes en el
 * otro idioma, y los suma a la tarjeta.
 *
 * Dos reglas gobiernan el caso de uso:
 *
 * - Nunca falla hacia arriba. Si el motor no responde, tarda o devuelve
 *   basura, se sigue con el vocabulario de siempre. Una sala no se queda sin
 *   agente porque una mejora del ruteo no haya salido.
 * - Nunca gasta dos veces lo mismo. El resultado se guarda por clave de
 *   contenido, así que reiniciar el daemon no cuesta cuota.
 */

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

  /**
   * Devuelve el vocabulario final del repositorio, ampliado si se ha podido.
   * Ante cualquier problema devuelve el que ya tenía, nunca menos.
   */
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
      const timer = setTimeout(
        () => reject(new Error(`agotados los ${this.config.timeoutMs} ms`)),
        this.config.timeoutMs,
      );
      // `unref` para que una ampliación en vuelo no mantenga vivo el proceso.
      timer.unref?.();
      work.then(resolve, reject).finally(() => clearTimeout(timer));
    });
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
