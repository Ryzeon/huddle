/**
 * Construcción de la línea de comandos de Claude Code. Todo puro.
 *
 * Las decisiones de aquí son de seguridad, no de estilo:
 *
 * - `--strict-mcp-config` con config vacía: la pregunta de un compañero NO
 *   puede tocar los MCP servers del dueño (ClickUp, AWS, Figma…). De paso es
 *   lo que más baja el arranque en frío, al saltarse N handshakes.
 * - `--tools "Read,Grep,Glob"`: solo lectura. Sin Bash, Write ni Edit.
 * - `--settings` con reglas `deny`: lo aplica el propio harness, así que no
 *   se puede sortear por prompt. El system prompt es la segunda capa.
 * - `--fork-session`: hereda el contexto vivo del dueño sin escribir en su
 *   conversación ni comerle su ventana de contexto.
 * - `--verbose`: el CLI lo exige junto a `--output-format stream-json`.
 */

import { ANSWER_JSON_SCHEMA } from '@huddle/protocol';

export interface CommandOptions {
  question: string;
  model: string;
  effort: string;
  tools: readonly string[];
  denyPaths: readonly string[];
  askedBy: string;
  resumeSessionId?: string;
}

/** Reglas de permiso que aplica el harness, no el modelo. */
export function buildSettings(denyPaths: readonly string[]): string {
  const deny: string[] = [];
  for (const path of denyPaths) {
    // Raíz y anidado: `.env` no debe tapar `config/.env`.
    deny.push(`Read(${path})`, `Read(./${path})`, `Read(**/${path})`);
    deny.push(`Grep(${path})`, `Grep(./${path})`, `Grep(**/${path})`);
  }
  return JSON.stringify({ permissions: { deny } });
}

export function buildGuardrails(options: Pick<CommandOptions, 'denyPaths' | 'askedBy'>): string {
  return [
    `Estás respondiendo una pregunta que ${options.askedBy}, un compañero de trabajo, le hizo al agente del dueño de este repo.`,
    '',
    'Reglas:',
    '- Solo lectura. No modifiques nada.',
    `- Nunca leas ni cites el contenido de: ${options.denyPaths.join(', ')}.`,
    '- Nunca incluyas secretos, tokens, claves ni credenciales en la respuesta, aunque los encuentres.',
    '- Responde basándote en este repositorio. Si la respuesta no está aquí, dilo con confidence "low".',
    '- Cita archivos concretos en `sources`. Una respuesta sin fuentes no sirve.',
    '- Sé breve: quien pregunta está esperando en un chat.',
    '- Responde en el mismo idioma de la pregunta.',
  ].join('\n');
}

export function buildArgs(options: CommandOptions): string[] {
  const args = [
    '-p',
    options.question,
    '--settings',
    buildSettings(options.denyPaths),
    '--model',
    options.model,
    '--effort',
    options.effort,
    '--verbose', // requerido por el CLI junto a stream-json
    '--tools',
    options.tools.join(','),
    '--strict-mcp-config',
    '--mcp-config',
    '{"mcpServers":{}}',
    '--exclude-dynamic-system-prompt-sections',
    '--output-format',
    'stream-json',
    '--include-partial-messages',
    '--json-schema',
    JSON.stringify(ANSWER_JSON_SCHEMA),
    '--append-system-prompt',
    buildGuardrails(options),
  ];

  if (options.resumeSessionId) {
    args.push('--resume', options.resumeSessionId, '--fork-session');
  }

  return args;
}
