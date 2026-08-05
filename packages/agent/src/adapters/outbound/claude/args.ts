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
  /** La copia local de la carpeta de la sala, si la hay. */
  folderDir?: string;
}

export function buildSettings(denyPaths: readonly string[]): string {
  const deny: string[] = [];
  for (const path of denyPaths) {
    // Raíz y anidado: `.env` no debe tapar `config/.env`.
    deny.push(`Read(${path})`, `Read(./${path})`, `Read(**/${path})`);
    deny.push(`Grep(${path})`, `Grep(./${path})`, `Grep(**/${path})`);
  }
  return JSON.stringify({ permissions: { deny } });
}

export function buildGuardrails(
  options: Pick<CommandOptions, 'denyPaths' | 'askedBy' | 'folderDir'>,
): string {
  const reglas = [
    '- Solo lectura. No modifiques nada.',
    `- Nunca leas ni cites el contenido de: ${options.denyPaths.join(', ')}.`,
    '- Nunca incluyas secretos, tokens, claves ni credenciales en la respuesta, aunque los encuentres.',
    '- Responde basándote en este repositorio. Si la respuesta no está aquí, dilo con confidence "low".',
    '- Cita archivos concretos en `sources`. Una respuesta sin fuentes no sirve.',
    // Con la carpeta de la sala delante, el atajo de «está en tal archivo» se
    // vuelve tentador: el agente encuentra el documento y remite a él. Pero
    // quien pregunta no lo tiene abierto — si lo tuviera, no habría preguntado.
    '- RESPONDE, no remitas. «Está en X.md» no es una respuesta: cuenta lo que',
    '  dice X.md y ponlo en `sources`. Quien pregunta no tiene ese archivo',
    '  delante, y esperar una respuesta para recibir un puntero es peor que no',
    '  haber preguntado.',
    '- Sé breve: quien pregunta está esperando en un chat.',
    '- Responde en el mismo idioma de la pregunta.',
  ];

  const carpeta = options.folderDir
    ? [
        '',
        `En ${options.folderDir} tienes la carpeta compartida de la sala: notas,`,
        'decisiones y contexto que ha ido escribiendo el equipo, más lo que ya se ha',
        'respondido antes ahí dentro. Está enlazada con wikilinks, así que buscar',
        '`[[temas/algo]]` saca el hilo entero.',
        '',
        '- Consúltala antes de responder si la pregunta huele a algo ya hablado.',
        '- Cítala en `sources` con su ruta, igual que un archivo del repositorio,',
        '  pero contando lo que pone: sigue sin valer mandar a leerla.',
        // Sin esto, una nota vieja del equipo pesaría lo mismo que el código, y
        // el agente contestaría con lo que se decidió hace tres meses en vez de
        // con lo que hoy hace el programa.
        '- Si la carpeta contradice al código, manda el código: la carpeta es lo',
        '  que el equipo dijo, el repositorio es lo que el programa hace.',
      ]
    : [];

  return [
    `Estás respondiendo una pregunta que ${options.askedBy}, un compañero de trabajo, le hizo al agente del dueño de este repo.`,
    '',
    'Reglas:',
    ...reglas,
    ...carpeta,
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

  // La carpeta de la sala entra como directorio adicional, no como texto en el
  // prompt: así se lee con Read y se busca con Grep, que es lo que hace que
  // esto escale sin índices ni recortes arbitrarios de contexto.
  if (options.folderDir) {
    args.push('--add-dir', options.folderDir);
  }

  if (options.resumeSessionId) {
    args.push('--resume', options.resumeSessionId, '--fork-session');
  }

  return args;
}
