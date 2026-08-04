/**
 * Persistencia en disco de cuota y caché.
 *
 * Escritura atómica (temp + rename) porque el daemon puede morir a mitad de
 * un guardado y un JSON truncado dejaría al agente sin poder arrancar.
 */

import { readFileSync, writeFileSync, renameSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { HUDDLE_DIR, ensureHuddleDir } from '../../config.js';
import type { QuotaState } from '../../domain/quota.js';
import type { CachedAnswer } from '../../domain/answer-cache.js';
import type {
  CacheStorePort,
  QuotaStorePort,
  VocabularyStorePort,
} from '../../application/ports/index.js';

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    // Un archivo corrupto no debe impedir arrancar: se empieza de cero.
    return fallback;
  }
}

function writeJsonAtomic(path: string, value: unknown): void {
  ensureHuddleDir();
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, path);
  } catch {
    if (existsSync(tmp)) {
      try {
        unlinkSync(tmp);
      } catch {
        /* nada que hacer */
      }
    }
  }
}

export function createQuotaStore(path = join(HUDDLE_DIR, 'quota.json')): QuotaStorePort {
  return {
    read: () => readJson<QuotaState | null>(path, null),
    write: (state) => writeJsonAtomic(path, state),
  };
}

export function createCacheStore(fileName = 'cache.json'): CacheStorePort {
  const path = join(HUDDLE_DIR, fileName);
  return {
    read: () => readJson<CachedAnswer[]>(path, []),
    write: (entries) => writeJsonAtomic(path, entries),
  };
}

/**
 * Vocabularios ampliados, todos en un archivo y bajo clave de contenido.
 *
 * Van juntos y no uno por repositorio porque son listas de pocas decenas de
 * palabras: un archivo por repo serían muchos archivos diminutos para nada.
 * La clave cambia sola cuando cambia la descripción del repositorio, así que
 * las entradas viejas quedan huérfanas; se limpian al reescribir.
 */
export function createVocabularyStore(
  path = join(HUDDLE_DIR, 'vocabulary.json'),
): VocabularyStorePort {
  return {
    read: (key) => readJson<Record<string, string[]>>(path, {})[key] ?? null,
    write: (key, terms) => {
      const all = readJson<Record<string, string[]>>(path, {});
      all[key] = terms;
      writeJsonAtomic(path, all);
    },
  };
}

/** Store en memoria, para tests. */
export function createMemoryQuotaStore(initial: QuotaState | null = null): QuotaStorePort {
  let state = initial;
  return {
    read: () => state,
    write: (next) => {
      state = next;
    },
  };
}

export function createMemoryCacheStore(initial: CachedAnswer[] = []): CacheStorePort {
  let entries = initial;
  return {
    read: () => entries,
    write: (next) => {
      entries = next;
    },
  };
}
