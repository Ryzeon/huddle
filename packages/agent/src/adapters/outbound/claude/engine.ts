import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import type {
  AnswerEnginePort,
  AnswerOutcome,
  AnswerProgress,
  AnswerRequest,
} from '../../../application/ports/index.js';
import { AnswerStreamExtractor } from './answer-stream.js';
import { buildArgs } from './args.js';
import { interpretEvent, toOutcome } from './stream.js';

export interface ClaudeEngineConfig {
  cwd: string;
  model: string;
  effort: string;
  tools: readonly string[];
  denyPaths: readonly string[];
  timeoutMs: number;
  /** La copia local de la carpeta de la sala. Ausente, se responde sin ella. */
  folderDir?: string;
}

export type SpawnFn = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; windowsHide?: boolean },
) => ChildProcessWithoutNullStreams;

const SIGKILL_GRACE_MS = 5_000;
const MAX_STDERR_BYTES = 4_000;

export class ClaudeCodeEngine implements AnswerEnginePort {
  constructor(
    private readonly config: ClaudeEngineConfig,
    private readonly spawn: SpawnFn = nodeSpawn as unknown as SpawnFn,
  ) {}

  async answer(request: AnswerRequest, progress: AnswerProgress = {}): Promise<AnswerOutcome> {
    const startedAt = Date.now();
    const extractor = new AnswerStreamExtractor();

    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.spawn('claude', buildArgs({ ...this.config, ...request }), {
        cwd: this.config.cwd,
        env: { ...process.env },
        // Sin esto, en Windows parpadea una consola por cada pregunta que
        // respondes. El daemon corre de fondo; sus hijos también deben.
        windowsHide: true,
      });
    } catch (error) {
      return failure(
        `no se pudo lanzar claude: ${error instanceof Error ? error.message : String(error)}`,
        Date.now() - startedAt,
      );
    }

    let finalEvent: Record<string, unknown> | undefined;
    let sessionId: string | undefined;
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      // Si ignora el TERM, no dejamos el proceso comiendo cuota indefinidamente.
      setTimeout(() => child.kill('SIGKILL'), SIGKILL_GRACE_MS).unref();
    }, this.config.timeoutMs);

    child.stderr.on('data', (buffer: Buffer) => {
      if (stderr.length < MAX_STDERR_BYTES) stderr += buffer.toString('utf8');
    });

    const reader = createInterface({
      input: child.stdout,
      crlfDelay: Number.POSITIVE_INFINITY,
    });

    reader.on('line', (line) => {
      if (!line.trim()) return;

      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return; // línea parcial o ruido; el stream continúa
      }

      for (const signal of interpretEvent(event)) {
        switch (signal.kind) {
          case 'text': {
            // El stream trae el JSON crudo; solo emitimos la parte legible.
            const readable = extractor.push(signal.text);
            if (readable) progress.onDelta?.(readable);
            break;
          }
          case 'tool':
            progress.onTrace?.(signal.description);
            break;
          case 'usage-limit':
            progress.onUsageLimit?.(signal.limit);
            break;
          case 'session':
            sessionId = signal.sessionId;
            break;
          case 'final':
            finalEvent = signal.raw;
            break;
          case 'ignore':
            break;
        }
      }
    });

    const exitCode = await new Promise<number>((resolve) => {
      child.on('error', () => resolve(-1));
      child.on('close', (code) => resolve(code ?? -1));
    });

    clearTimeout(timer);
    reader.close();

    const durationMs = Date.now() - startedAt;

    if (timedOut) {
      return failure(
        `se cortó a los ${Math.round(this.config.timeoutMs / 1000)}s`,
        durationMs,
        sessionId,
      );
    }
    if (!finalEvent) {
      return failure(
        stderr.trim() || `claude terminó sin resultado (código ${exitCode})`,
        durationMs,
        sessionId,
      );
    }

    return toOutcome(finalEvent, durationMs, sessionId);
  }
}

function failure(error: string, durationMs: number, sessionId?: string): AnswerOutcome {
  return {
    ok: false,
    answer: '',
    sources: [],
    confidence: 'low',
    needsEscalation: false,
    sessionId,
    turns: 0,
    durationMs,
    error,
  };
}
