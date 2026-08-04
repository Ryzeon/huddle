/**
 * Interpretación del stream NDJSON de `claude --output-format stream-json`.
 *
 * Puro: entra un evento ya parseado, sale una decisión. El proceso y su
 * ciclo de vida viven en `engine.ts`.
 */

import type { SourceRef } from '@huddle/protocol';
import type { AnswerOutcome, UsageLimit } from '../../../application/ports/index.js';

export type StreamSignal =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; description: string }
  | { kind: 'usage-limit'; limit: UsageLimit }
  | { kind: 'session'; sessionId: string }
  | { kind: 'final'; raw: Record<string, unknown> }
  | { kind: 'ignore' };

export function interpretEvent(event: Record<string, unknown>): StreamSignal[] {
  const signals: StreamSignal[] = [];

  if (typeof event.session_id === 'string') {
    signals.push({ kind: 'session', sessionId: event.session_id });
  }

  switch (event.type) {
    case 'stream_event': {
      const text = textDelta(event);
      if (text !== null) signals.push({ kind: 'text', text });
      break;
    }
    case 'assistant': {
      for (const description of toolUses(event)) {
        signals.push({ kind: 'tool', description });
      }
      break;
    }
    case 'rate_limit_event': {
      const info = event.rate_limit_info as Record<string, unknown> | undefined;
      if (info && typeof info.status === 'string') {
        signals.push({
          kind: 'usage-limit',
          limit: {
            status: info.status,
            kind: typeof info.rateLimitType === 'string' ? info.rateLimitType : undefined,
            resetsAt: typeof info.resetsAt === 'number' ? info.resetsAt : undefined,
          },
        });
      }
      break;
    }
    case 'result':
      signals.push({ kind: 'final', raw: event });
      break;
    default:
      break;
  }

  return signals.length > 0 ? signals : [{ kind: 'ignore' }];
}

/** Texto de la respuesta. Los `thinking_delta` se ignoran: no son respuesta. */
function textDelta(event: Record<string, unknown>): string | null {
  const inner = event.event as Record<string, unknown> | undefined;
  if (!inner || inner.type !== 'content_block_delta') return null;
  const delta = inner.delta as Record<string, unknown> | undefined;
  if (!delta || delta.type !== 'text_delta' || typeof delta.text !== 'string') return null;
  return delta.text;
}

function toolUses(event: Record<string, unknown>): string[] {
  const message = event.message as Record<string, unknown> | undefined;
  const content = message?.content;
  if (!Array.isArray(content)) return [];

  const out: string[] = [];
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const typed = block as Record<string, unknown>;
    if (typed.type === 'tool_use' && typeof typed.name === 'string') {
      out.push(describeToolUse(typed.name, typed.input));
    }
  }
  return out;
}

/**
 * Traduce un `tool_use` a una línea legible.
 * Nunca expone el input completo: puede traer rutas o contenido sensible.
 */
export function describeToolUse(name: string, input: unknown): string {
  const args = (input ?? {}) as Record<string, unknown>;
  const target =
    typeof args.file_path === 'string'
      ? args.file_path
      : typeof args.pattern === 'string'
        ? args.pattern
        : typeof args.path === 'string'
          ? args.path
          : '';
  const short = target.length > 80 ? `…${target.slice(-77)}` : target;

  switch (name) {
    case 'Read':
      return short ? `leyendo ${short}` : 'leyendo un archivo';
    case 'Grep':
      return short ? `buscando "${short}"` : 'buscando en el repo';
    case 'Glob':
      return short ? `listando ${short}` : 'explorando el repo';
    default:
      return `usando ${name}`;
  }
}

export interface ParsedAnswer {
  answer: string;
  sources: SourceRef[];
  confidence: 'low' | 'medium' | 'high';
  needsEscalation: boolean;
}

/**
 * `--json-schema` normalmente garantiza la forma, pero si algo sale raro
 * preferimos degradar a texto plano antes que perder la respuesta entera.
 */
export function parseAnswerPayload(raw: string): ParsedAnswer {
  const fallback: ParsedAnswer = {
    answer: raw.trim(),
    sources: [],
    confidence: 'low',
    needsEscalation: true,
  };

  if (!raw.trim().startsWith('{')) return fallback;

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.answer !== 'string') return fallback;

    return {
      answer: parsed.answer,
      sources: parseSources(parsed.sources),
      confidence:
        parsed.confidence === 'high' || parsed.confidence === 'medium' || parsed.confidence === 'low'
          ? parsed.confidence
          : 'medium',
      needsEscalation: parsed.needsEscalation === true,
    };
  } catch {
    return fallback;
  }
}

function parseSources(value: unknown): SourceRef[] {
  if (!Array.isArray(value)) return [];
  const out: SourceRef[] = [];
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) continue;
    const source = raw as Record<string, unknown>;
    if (typeof source.file !== 'string') continue;
    const ref: SourceRef = { file: source.file };
    if (typeof source.line === 'number') ref.line = source.line;
    out.push(ref);
  }
  return out;
}

/** Convierte el evento `result` del CLI en el resultado del puerto. */
export function toOutcome(
  result: Record<string, unknown>,
  durationMs: number,
  sessionId: string | undefined,
): AnswerOutcome {
  const base = {
    sessionId,
    model: firstModelName(result),
    turns: typeof result.num_turns === 'number' ? result.num_turns : 0,
    ttftMs: typeof result.ttft_ms === 'number' ? result.ttft_ms : undefined,
    durationMs,
  };

  if (result.is_error === true) {
    return {
      ...base,
      ok: false,
      answer: '',
      sources: [],
      confidence: 'low',
      needsEscalation: true,
      error: typeof result.result === 'string' ? result.result.slice(0, 500) : 'error del agente',
    };
  }

  const parsed = parseAnswerPayload(typeof result.result === 'string' ? result.result : '');
  return { ...base, ok: true, ...parsed };
}

function firstModelName(result: Record<string, unknown>): string | undefined {
  const usage = result.modelUsage as Record<string, unknown> | undefined;
  if (!usage) return undefined;
  return Object.keys(usage)[0];
}
