/**
 * Adaptador de salida: describe el repositorio expuesto leyendo git y el disco.
 *
 * Implementa `RepoInspectorPort`. En los tests se reemplaza por un objeto
 * literal, así que ningún caso de uso necesita un repo de verdad.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { RepoInspectorPort, RepoSnapshot } from '../../application/ports/index.js';

const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', 'target', 'vendor',
  '__pycache__', '.venv', 'venv', '.turbo', 'coverage', '.cache',
]);

const MAX_DIRS = 40;
const MAX_SUMMARY_CHARS = 400;
const MAX_KEYWORDS = 40;

/**
 * Tope de nombres de dependencias en la tarjeta.
 *
 * Un `package.json` de una app con interfaz trae cincuenta. Son términos
 * legítimos —alguien puede preguntar «¿cómo montasteis el gráfico?»— pero son
 * la señal más débil que hay, y sin tope se comen la tarjeta entera y dejan
 * fuera lo que de verdad identifica al repositorio.
 */
const MAX_DEPENDENCY_TERMS = 12;
const GIT_TIMEOUT_MS = 3_000;

/** Manifiestos de los que sacar el nombre y la descripción del proyecto. */
const MANIFESTS = [
  'package.json',
  'pyproject.toml',
  'go.mod',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'Cargo.toml',
  'composer.json',
] as const;

export class GitRepoInspector implements RepoInspectorPort {
  constructor(private readonly cwd: string) {}

  snapshot(): RepoSnapshot {
    const remote = this.git(['config', '--get', 'remote.origin.url']);

    const snapshot: RepoSnapshot = {
      repo: remote ? repoNameFromRemote(remote) : basename(this.cwd),
      dirs: this.topLevelDirs(),
    };

    const branch = this.currentBranch();
    const sha = this.currentSha();
    const summary = this.readSummary();
    const keywords = this.manifestKeywords();
    if (remote) snapshot.remote = remote;
    if (branch) snapshot.branch = branch;
    if (sha) snapshot.sha = sha;
    if (summary) snapshot.summary = summary;
    if (keywords.length > 0) snapshot.keywords = keywords;

    return snapshot;
  }

  currentSha(): string | undefined {
    return this.git(['rev-parse', '--short', 'HEAD']);
  }

  currentBranch(): string | undefined {
    return this.git(['rev-parse', '--abbrev-ref', 'HEAD']);
  }

  private git(args: string[]): string | undefined {
    try {
      return execFileSync('git', args, {
        cwd: this.cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: GIT_TIMEOUT_MS,
      }).trim();
    } catch {
      // No ser un repo git es un caso válido, no un error.
      return undefined;
    }
  }

  /**
   * Directorios hasta segundo nivel.
   *
   * Saber que un repositorio tiene `src` no distingue nada; saber que tiene
   * `src/billing` o `src/auth` es justo lo que necesita el ruteo para no
   * mandarle una pregunta de cobros a quien trabaja en infraestructura.
   */
  private topLevelDirs(): string[] {
    const usable = (name: string): boolean =>
      !name.startsWith('.') && !IGNORED_DIRS.has(name);

    try {
      const out: string[] = [];
      for (const entry of readdirSync(this.cwd, { withFileTypes: true })) {
        if (!entry.isDirectory() || !usable(entry.name)) continue;
        out.push(entry.name);

        try {
          for (const child of readdirSync(join(this.cwd, entry.name), { withFileTypes: true })) {
            if (!child.isDirectory() || !usable(child.name)) continue;
            out.push(`${entry.name}/${child.name}`);
            if (out.length >= MAX_DIRS) return out;
          }
        } catch {
          // Carpeta ilegible: el primer nivel ya quedó registrado.
        }
      }
      return out.slice(0, MAX_DIRS);
    } catch {
      return [];
    }
  }

  /**
   * Encabezado del CLAUDE.md o, si no hay, del README.
   * Muchos repositorios no tienen CLAUDE.md, y quedarse sin resumen dejaba al
   * ruteo sin nada donde enganchar.
   */
  private readSummary(): string | undefined {
    for (const name of ['CLAUDE.md', 'README.md', 'readme.md']) {
      const path = join(this.cwd, name);
      if (!existsSync(path)) continue;

      try {
        const text = describeLines(readFileSync(path, 'utf8'))
          .slice(0, 6)
          .join(' ')
          .slice(0, MAX_SUMMARY_CHARS);
        if (text.trim()) return text;
      } catch {
        // Ilegible: se prueba el siguiente.
      }
    }
    return undefined;
  }

  /** Términos sacados de los manifiestos que haya en la raíz. */
  private manifestKeywords(): string[] {
    const terms = new Set<string>();

    for (const name of MANIFESTS) {
      const path = join(this.cwd, name);
      if (!existsSync(path)) continue;

      try {
        for (const term of manifestTerms(name, readFileSync(path, 'utf8'))) {
          terms.add(term);
          if (terms.size >= MAX_KEYWORDS) return [...terms];
        }
      } catch {
        // Manifiesto ilegible: se sigue con el resto.
      }
    }

    return [...terms];
  }
}

/**
 * Palabras que aparecen en cualquier manifiesto y no dicen nada del proyecto.
 * Sin esta lista, media tarjeta serían nombres de campos.
 */
const MANIFEST_NOISE = new Set([
  'true', 'false', 'null', 'none', 'name', 'version', 'license', 'main', 'type',
  'module', 'index', 'dist', 'build', 'test', 'tests', 'src', 'lib', 'bin',
  'files', 'scripts', 'private', 'description', 'keywords', 'dependencies',
  'author', 'repository', 'homepage', 'engines', 'exports', 'workspaces',
  'project', 'group', 'artifact', 'packaging', 'properties', 'parent', 'jar',
  'com', 'org', 'net', 'io', 'github', 'gitlab', 'www', 'http', 'https',
  // Texto de plantilla: casi todo esqueleto de framework lo trae igual.
  'the', 'and', 'for', 'with', 'framework', 'boilerplate', 'starter', 'template',
  'skeleton', 'application', 'package', 'library',
]);

/**
 * Términos con los que un manifiesto describe su proyecto.
 *
 * Se leen los campos que significan algo (nombre, descripción, etiquetas y
 * nombres de dependencias) en vez de partir el archivo en palabras. La versión
 * anterior hacía justo eso, y una tarjeta de `package.json` acababa siendo
 * `scripts`, `--watch`, `node_modules` y `babel`: cuarenta términos que no
 * distinguen un repositorio de ningún otro, ocupando el sitio de los que sí.
 *
 * Las dependencias de desarrollo quedan fuera a propósito. Que un proyecto use
 * eslint no ayuda a decidir a quién se le pregunta.
 */
export function manifestTerms(fileName: string, content: string): string[] {
  if (fileName.endsWith('.json')) return jsonManifestTerms(content);

  const raw =
    fileName === 'pom.xml'
        ? matchAll(content, /<(?:artifactId|name|description)>([^<]+)<\//g)
        : fileName === 'go.mod'
          ? matchAll(content, /^\s*(?:module|require)?\s*([\w.\-/]+\.[\w-]+\/[\w.\-/]+)/gm)
          : fileName.startsWith('build.gradle')
            ? matchAll(content, /['"]([\w.-]+:[\w.-]+)(?::[^'"]*)?['"]/g)
            : tomlManifestTerms(content);

  return cleanTerms(raw);
}

/** `package.json` y `composer.json`: los campos que describen, no el resto. */
function jsonManifestTerms(content: string): string[] {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return [];
  }

  const identity: string[] = [];
  for (const field of ['name', 'description'] as const) {
    if (typeof parsed[field] === 'string') identity.push(parsed[field]);
  }
  if (Array.isArray(parsed['keywords'])) {
    identity.push(...parsed['keywords'].filter((k): k is string => typeof k === 'string'));
  }

  // Solo las de producción: las de desarrollo son herramientas, no dominio.
  const deps = parsed['dependencies'] ?? parsed['require'];
  const dependencies =
    deps && typeof deps === 'object'
      ? cleanTerms(Object.keys(deps)).slice(0, MAX_DEPENDENCY_TERMS)
      : [];

  // La identidad primero: si algo se cae por el tope, que sea una dependencia.
  return [...cleanTerms(identity), ...dependencies];
}

/** `Cargo.toml` y `pyproject.toml`: `name`, `description` y `keywords`. */
function tomlManifestTerms(content: string): string[] {
  return [
    ...matchAll(content, /^\s*(?:name|description)\s*=\s*["']([^"']+)["']/gm),
    ...matchAll(content, /^\s*keywords\s*=\s*\[([^\]]*)\]/gm),
  ];
}

function matchAll(content: string, pattern: RegExp): string[] {
  return [...content.matchAll(pattern)].map((match) => match[1] ?? '');
}

/**
 * Parte las frases en palabras, quita rutas y ámbitos, y descarta el ruido.
 * `@scope/paquete` y `github.com/org/repo` se quedan en su último tramo, que
 * es el que alguien escribiría al preguntar.
 */
function cleanTerms(raw: readonly string[]): string[] {
  const out: string[] = [];

  for (const value of raw) {
    for (const chunk of value.split(/[\s,]+/)) {
      const tail = chunk.split(/[/:]/).pop() ?? chunk;
      const term = tail.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9_-]+$/g, '');
      if (term.length < 3 || term.length > 40) continue;
      if (MANIFEST_NOISE.has(term)) continue;
      if (/^[\d.]+$/.test(term)) continue; // versiones
      out.push(term);
    }
  }

  return out;
}

/**
 * Líneas del README que describen el proyecto, descartando lo que no lo hace.
 *
 * Los bloques de código son la trampa: el README de esta misma herramienta
 * incluye de ejemplo "¿En qué puerto corre el servicio de facturación?", y al
 * indexarlo la tarjeta acababa encajando con preguntas sobre facturación —
 * ganándole al repositorio que sí trata de eso.
 */
export function describeLines(markdown: string): string[] {
  const out: string[] = [];
  let insideFence = false;

  for (const raw of markdown.split('\n')) {
    const line = raw.trim();

    if (line.startsWith('```') || line.startsWith('~~~')) {
      insideFence = !insideFence;
      continue;
    }
    if (insideFence) continue;

    if (!line) continue;
    if (line.startsWith('#')) continue; // encabezado
    if (line.startsWith('![')) continue; // insignia o imagen
    if (line.startsWith('|') || line.startsWith('---')) continue; // tabla o separador
    if (raw.startsWith('    ')) continue; // bloque de código indentado
    if (line.startsWith('$ ') || line.startsWith('> $')) continue; // comando de ejemplo

    out.push(line);
  }

  return out;
}

function repoNameFromRemote(remote: string): string {
  const cleaned = remote.replace(/\.git$/, '');
  const parts = cleaned.split(/[/:]/);
  return parts[parts.length - 1] || cleaned;
}
