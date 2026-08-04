/**
 * Adaptador de salida: amplía el vocabulario con el CLI de Claude Code.
 *
 * Es la llamada más barata del agente y la única que no toca el repositorio:
 * va con `--tools ''`, así que el modelo no puede leer un archivo aunque
 * quiera. Solo ve la tarjeta, que es justo lo que la sala ya conoce.
 *
 * Se lanza desde `tmpdir` y no desde el repositorio por la misma razón: si
 * algún día cambiara el valor por defecto de las herramientas, no habría nada
 * alrededor que leer.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import type {
  RepoSnapshot,
  VocabularyExpanderPort,
} from '../../../application/ports/index.js';
import type { SpawnFn } from './engine.js';

/**
 * El modelo devuelve una lista de términos y nada más. Sin el esquema
 * contestaría en prosa y habría que adivinar dónde acaba cada término.
 */
const VOCABULARY_JSON_SCHEMA = {
  type: 'object',
  properties: {
    terms: {
      type: 'array',
      items: { type: 'string' },
      minItems: 5,
      maxItems: 40,
    },
  },
  required: ['terms'],
  additionalProperties: false,
} as const;

export interface VocabularyExpanderConfig {
  /** Barato a propósito: esto no razona, enumera. */
  model: string;
  timeoutMs: number;
}

export class ClaudeVocabularyExpander implements VocabularyExpanderPort {
  constructor(
    private readonly config: VocabularyExpanderConfig,
    private readonly spawn: SpawnFn = nodeSpawn as unknown as SpawnFn,
  ) {}

  async expand(snapshot: RepoSnapshot): Promise<string[]> {
    const child = this.spawn('claude', buildVocabularyArgs(snapshot, this.config), {
      cwd: tmpdir(),
      env: { ...process.env },
    });

    // Sin cerrar la entrada, el CLI espera datos por stdin durante segundos.
    child.stdin.end();

    let stdout = '';
    child.stdout.on('data', (buffer: Buffer) => {
      stdout += buffer.toString('utf8');
    });

    const timer = setTimeout(() => child.kill('SIGKILL'), this.config.timeoutMs);
    timer.unref?.();

    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    }).finally(() => clearTimeout(timer));

    if (code !== 0) throw new Error(`claude terminó con código ${String(code)}`);

    return readTerms(stdout);
  }
}

/**
 * Saca los términos de la respuesta del CLI.
 *
 * Con `--json-schema` el resultado viene ya validado en `structured_output`;
 * `result` es el mismo objeto en texto y sirve de reserva por si cambia la
 * forma del sobre.
 */
function readTerms(stdout: string): string[] {
  const envelope = JSON.parse(stdout) as {
    structured_output?: { terms?: unknown };
    result?: string;
  };

  if (Array.isArray(envelope.structured_output?.terms)) {
    return envelope.structured_output.terms as string[];
  }

  if (typeof envelope.result === 'string') {
    const parsed = JSON.parse(envelope.result) as { terms?: unknown };
    if (Array.isArray(parsed.terms)) return parsed.terms as string[];
  }

  return [];
}

export function buildVocabularyArgs(
  snapshot: RepoSnapshot,
  config: VocabularyExpanderConfig,
): string[] {
  return [
    '-p',
    buildPrompt(snapshot),
    '--model',
    config.model,
    '--effort',
    'low',
    // Ninguna herramienta: esta llamada no lee el repositorio, solo su tarjeta.
    '--tools',
    '',
    '--strict-mcp-config',
    '--mcp-config',
    '{"mcpServers":{}}',
    '--exclude-dynamic-system-prompt-sections',
    '--output-format',
    'json',
    '--json-schema',
    JSON.stringify(VOCABULARY_JSON_SCHEMA),
  ];
}

/**
 * Lo que se le enseña del repositorio es exactamente la tarjeta, ni más ni
 * menos. La instrucción de no inventar importa: un término que nadie va a
 * escribir no ayuda, y uno que pertenece a otro repositorio hace que `@auto`
 * mande la pregunta a quien no toca.
 */
function buildPrompt(snapshot: RepoSnapshot): string {
  const card = [
    `repositorio: ${snapshot.repo}`,
    snapshot.dirs.length > 0 ? `directorios: ${snapshot.dirs.join(', ')}` : '',
    snapshot.summary ? `resumen: ${snapshot.summary}` : '',
    snapshot.keywords?.length ? `manifiestos: ${snapshot.keywords.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  return `${card}

Devuelve los términos con los que alguien de este equipo podría preguntar por
este repositorio: sinónimos, el equivalente en inglés y en español, y los
nombres del dominio del que trata.

El nombre del repositorio suele llevar dentro el dominio: desarróllalo y
tradúcelo. Uno llamado "alkila-facturador" trata de facturación, comprobantes,
invoices y billing, aunque su manifiesto no lo diga en ninguna parte. Eso no es
inventar, es leer el nombre.

Los directorios ayudan igual. El manifiesto es el peor indicio de los tres:
suele traer el texto de plantilla del framework, y si dice cosas como "The
Laravel Framework" hay que ignorarlo.

Sustantivos y nombres del dominio, en minúsculas. Nada de verbos genéricos
(enviar, send, crear, listar) ni palabras que valdrían para cualquier
repositorio (api, servicio, app, sistema): esas hacen que le lleguen preguntas
de otros. No expliques nada y no inventes lo que no se deduzca de lo anterior.`;
}
