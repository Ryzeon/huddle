export function formatSeconds(ms: number): string {
  if (ms < 1_000) return `${ms} ms`;
  const seconds = ms / 1_000;
  return seconds < 10 ? `${seconds.toFixed(1)} s` : `${Math.round(seconds)} s`;
}

export function describeAnswer(
  elapsedMs: number | undefined,
  cached: boolean | undefined,
  confidence?: string,
): string | undefined {
  const parts: string[] = [];
  if (elapsedMs !== undefined) parts.push(formatSeconds(elapsedMs));
  if (cached) parts.push('caché');
  if (confidence) parts.push(confidence);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

export function describeFailure(elapsedMs: number | undefined): string {
  return elapsedMs === undefined
    ? 'sin respuesta'
    : `${formatSeconds(elapsedMs)} · sin respuesta`;
}

const ERROR_TEXT: Record<string, string> = {
  denied_by_owner: 'el dueño no aceptó la pregunta',
  quota_exceeded: 'cuota agotada',
  timeout: 'se agotó el tiempo',
  target_offline: 'ese agente no está en la sala',
  agent_failed: 'el agente falló al responder',
  rate_limited: 'demasiadas preguntas seguidas',
  bad_request: 'petición inválida',
};

export function errorText(reason: string): string {
  return ERROR_TEXT[reason] ?? reason;
}
