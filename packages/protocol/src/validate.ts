/**
 * Validación de frontera.
 *
 * Todo lo que entra por el socket es hostil hasta que se demuestre lo
 * contrario. `parseMessage` solo garantiza "es JSON con un campo `t`";
 * estas funciones garantizan que la forma es la que dice ser, para que el
 * resto del código pueda usar los tipos sin castear.
 */

import type {
  AdmitGuestMessage,
  CloseRoomMessage,
  DenyGuestMessage,
  AskMessage,
  CreateRoomMessage,
  KickMessage,
  CapabilityCard,
  ChatMessage,
  ChunkMessage,
  ClientMessage,
  ErrorMessage,
  IdentityProof,
  JoinMessage,
  ResultMessage,
  RotateCodeMessage,
  SourceRef,
  TraceMessage,
  FolderPutMessage,
  FolderDropMessage,
  FolderGetMessage,
  FolderWrite,
} from './index.js';
import { normalizeAlias, normalizeFolderPath, normalizeTag } from './index.js';

export class ValidationError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(`${field}: ${message}`);
    this.name = 'ValidationError';
    this.field = field;
  }
}

export const LIMITS = {
  question: 8_000,
  answer: 200_000,
  chatText: 4_000,
  roomCode: 64,
  roomName: 64,
  sources: 50,
  dirs: 100,
  keywords: 80,
  summary: 1_000,
  traceText: 500,
  nonce: 64,
  /** Ed25519 en base64url crudo: 32 bytes son exactamente 43 caracteres. */
  pubkey: 43,
  /** Firma Ed25519: 64 bytes, 86 caracteres. */
  sig: 86,
  /** Un archivo de la carpeta. El frame del hub corta en 1 MB; esto deja sitio al JSON. */
  folderText: 256_000,
  folderPath: 160,
  /** Cuántos archivos caben en la carpeta de una sala. */
  folderFiles: 500,
} as const;

const B64U = /^[A-Za-z0-9_-]+$/;

type Obj = Record<string, unknown>;

function asObject(value: unknown, field: string): Obj {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValidationError(field, 'se esperaba un objeto');
  }
  return value as Obj;
}

function str(obj: Obj, field: string, max: number, opts?: { optional?: boolean }): string {
  const value = obj[field];
  if (value === undefined || value === null) {
    if (opts?.optional) return '';
    throw new ValidationError(field, 'requerido');
  }
  if (typeof value !== 'string') throw new ValidationError(field, 'se esperaba string');
  if (value.length > max) {
    throw new ValidationError(field, `supera el máximo de ${max} caracteres`);
  }
  return value;
}

function optionalStr(obj: Obj, field: string, max: number): string | undefined {
  if (obj[field] === undefined || obj[field] === null) return undefined;
  return str(obj, field, max);
}

function int(obj: Obj, field: string, min: number, max: number, fallback?: number): number {
  const value = obj[field];
  if (value === undefined || value === null) {
    if (fallback !== undefined) return fallback;
    throw new ValidationError(field, 'requerido');
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ValidationError(field, 'se esperaba un número');
  }
  return Math.min(Math.max(Math.trunc(value), min), max);
}

function strArray(obj: Obj, field: string, maxItems: number, maxLen: number): string[] {
  const value = obj[field];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ValidationError(field, 'se esperaba un array');
  return value
    .filter((v): v is string => typeof v === 'string')
    .slice(0, maxItems)
    .map((v) => v.slice(0, maxLen));
}

function oneOf<T extends string>(obj: Obj, field: string, allowed: readonly T[], fallback: T): T {
  const value = obj[field];
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) {
    return value as T;
  }
  return fallback;
}

function validateCard(value: unknown): CapabilityCard | undefined {
  if (value === undefined || value === null) return undefined;
  const obj = asObject(value, 'card');
  const card: CapabilityCard = {
    repo: str(obj, 'repo', 200),
    dirs: strArray(obj, 'dirs', LIMITS.dirs, 100),
  };
  const remote = optionalStr(obj, 'remote', 500);
  const branch = optionalStr(obj, 'branch', 200);
  const sha = optionalStr(obj, 'sha', 64);
  const summary = optionalStr(obj, 'summary', LIMITS.summary);
  const keywords = strArray(obj, 'keywords', LIMITS.keywords, 60);
  if (keywords.length > 0) card.keywords = keywords;
  if (remote) card.remote = remote;
  if (branch) card.branch = branch;
  if (sha) card.sha = sha;
  if (summary) card.summary = summary;
  return card;
}

/**
 * La prueba de identidad. Las longitudes son exactas, no máximos: cualquier
 * otra cosa no es una clave Ed25519 y no hay por qué pasársela a la
 * criptografía para que lo descubra ella.
 */
export function validateProof(value: unknown): IdentityProof | undefined {
  if (value === undefined || value === null) return undefined;
  const obj = asObject(value, 'proof');

  const pubkey = str(obj, 'pubkey', LIMITS.pubkey);
  const sig = str(obj, 'sig', LIMITS.sig);
  const nonce = str(obj, 'nonce', LIMITS.nonce);

  if (pubkey.length !== LIMITS.pubkey || !B64U.test(pubkey)) {
    throw new ValidationError('proof.pubkey', 'no es una clave Ed25519 en base64url');
  }
  if (sig.length !== LIMITS.sig || !B64U.test(sig)) {
    throw new ValidationError('proof.sig', 'no es una firma Ed25519 en base64url');
  }
  if (!B64U.test(nonce)) {
    throw new ValidationError('proof.nonce', 'no es base64url');
  }
  return { pubkey, sig, nonce };
}

/**
 * La ruta de un archivo de la carpeta, ya saneada.
 *
 * `normalizeFolderPath` lanza `Error` a secas porque también lo usan la CLI y
 * el portal, donde `ValidationError` no significa nada. Aquí se traduce, para
 * que el motivo real llegue al cliente en vez de un «frame inválido».
 */
function folderPath(obj: Obj): string {
  const raw = str(obj, 'path', LIMITS.folderPath);
  try {
    return normalizeFolderPath(raw);
  } catch (error) {
    throw new ValidationError('path', error instanceof Error ? error.message : 'ruta inválida');
  }
}

function validateSources(value: unknown): SourceRef[] {
  if (!Array.isArray(value)) return [];
  const out: SourceRef[] = [];
  for (const raw of value.slice(0, LIMITS.sources)) {
    if (typeof raw !== 'object' || raw === null) continue;
    const obj = raw as Obj;
    if (typeof obj.file !== 'string') continue;
    const ref: SourceRef = { file: obj.file.slice(0, 500) };
    if (typeof obj.line === 'number' && Number.isFinite(obj.line)) {
      ref.line = Math.max(1, Math.trunc(obj.line));
    }
    out.push(ref);
  }
  return out;
}

export function validateClientMessage(msg: { t: string } & Obj): ClientMessage {
  switch (msg.t) {
    case 'create': {
      const out: CreateRoomMessage = {
        t: 'create',
        v: int(msg, 'v', 0, 1000),
        name: str(msg, 'name', LIMITS.roomName),
        alias: normalizeAlias(str(msg, 'alias', 64)),
        quotaRemaining:
          msg.quotaRemaining === null || msg.quotaRemaining === undefined
            ? null
            : int(msg, 'quotaRemaining', 0, 1_000_000),
      };
      if (!out.name.trim()) throw new ValidationError('name', 'la sala necesita un nombre');
      const tag = optionalStr(msg, 'tag', 64);
      if (tag) out.tag = normalizeTag(tag);
      const card = validateCard(msg.card);
      if (card) out.card = card;
      const proof = validateProof(msg.proof);
      if (proof) out.proof = proof;

      const policy = oneOf(msg, 'policy', ['open', 'approved'] as const, 'open');
      // Sin firma, aprobar un alias no aprueba nada: quien vuelve podría ser
      // cualquiera. Degradar a `open` en silencio sería el peor fallo posible,
      // porque la sala parecería cerrada y no lo estaría.
      if (policy === 'approved' && !proof) {
        throw new ValidationError(
          'policy',
          'una sala con aprobación exige firmar el alias; este cliente no puede firmar',
        );
      }
      if (policy === 'approved') out.policy = policy;

      const folderWrite = oneOf(msg, 'folderWrite', ['all', 'host'] as const, 'all');
      if (folderWrite === 'host') out.folderWrite = folderWrite satisfies FolderWrite;
      // La memoria va encendida salvo que se pida lo contrario, así que solo
      // viaja el `false`: una sala donde no quiere quedar rastro escrito.
      if (msg.folderMemory === false) out.folderMemory = false;
      return out;
    }

    case 'admit': {
      const out: AdmitGuestMessage = { t: 'admit', id: str(msg, 'id', 64) };
      if (msg.remember === false) out.remember = false;
      return out;
    }

    case 'deny': {
      const out: DenyGuestMessage = { t: 'deny', id: str(msg, 'id', 64) };
      const reason = optionalStr(msg, 'reason', 200);
      if (reason) out.reason = reason;
      return out;
    }

    case 'close': {
      const out: CloseRoomMessage = { t: 'close' };
      const motivo = optionalStr(msg, 'reason', 200);
      if (motivo) out.reason = motivo;
      return out;
    }

    case 'rotate': {
      // El id es obligatorio, al revés que en `close`: la respuesta llega
      // asíncrona y sin id no se sabe si el error es de esta rotación.
      const out: RotateCodeMessage = { t: 'rotate', id: str(msg, 'id', 64) };
      const reason = optionalStr(msg, 'reason', 200);
      if (reason) out.reason = reason;
      return out;
    }

    case 'kick': {
      const out: KickMessage = {
        t: 'kick',
        alias: normalizeAlias(str(msg, 'alias', 64)),
      };
      const reason = optionalStr(msg, 'reason', 200);
      if (reason) out.reason = reason;
      return out;
    }

    case 'join': {
      const out: JoinMessage = {
        t: 'join',
        v: int(msg, 'v', 0, 1000),
        room: str(msg, 'room', LIMITS.roomCode),
        alias: normalizeAlias(str(msg, 'alias', 64)),
        quotaRemaining:
          msg.quotaRemaining === null || msg.quotaRemaining === undefined
            ? null
            : int(msg, 'quotaRemaining', 0, 1_000_000),
      };
      const tag = optionalStr(msg, 'tag', 64);
      if (tag) out.tag = normalizeTag(tag);
      if (msg.viewer === true) out.viewer = true;
      const card = validateCard(msg.card);
      if (card) out.card = card;
      const proof = validateProof(msg.proof);
      if (proof) out.proof = proof;
      return out;
    }

    case 'ask': {
      const out: AskMessage = {
        t: 'ask',
        id: str(msg, 'id', 64),
        to: validateTarget(str(msg, 'to', 64)),
        q: str(msg, 'q', LIMITS.question),
        ttl: int(msg, 'ttl', 10, 300, 120),
      };
      if (!out.q.trim()) throw new ValidationError('q', 'la pregunta viene vacía');
      return out;
    }

    case 'msg': {
      const out: ChatMessage = { t: 'msg', text: str(msg, 'text', LIMITS.chatText) };
      return out;
    }

    case 'chunk': {
      const out: ChunkMessage = {
        t: 'chunk',
        id: str(msg, 'id', 64),
        delta: str(msg, 'delta', LIMITS.answer),
      };
      return out;
    }

    case 'trace': {
      const out: TraceMessage = {
        t: 'trace',
        id: str(msg, 'id', 64),
        text: str(msg, 'text', LIMITS.traceText),
      };
      return out;
    }

    case 'result': {
      const out: ResultMessage = {
        t: 'result',
        id: str(msg, 'id', 64),
        answer: str(msg, 'answer', LIMITS.answer),
        sources: validateSources(msg.sources),
        confidence: oneOf(msg, 'confidence', ['low', 'medium', 'high'] as const, 'medium'),
        elapsedMs: int(msg, 'elapsedMs', 0, 24 * 60 * 60 * 1000, 0),
        cached: msg.cached === true,
      };
      const branch = optionalStr(msg, 'branch', 200);
      const sha = optionalStr(msg, 'sha', 64);
      const model = optionalStr(msg, 'model', 100);
      if (branch) out.branch = branch;
      if (sha) out.sha = sha;
      if (model) out.model = model;
      return out;
    }

    case 'error': {
      const out: ErrorMessage = {
        t: 'error',
        id: str(msg, 'id', 64),
        reason: oneOf(
          msg,
          'reason',
          [
            'denied_by_owner',
            'quota_exceeded',
            'timeout',
            'target_offline',
            'agent_failed',
            'rate_limited',
            'bad_request',
            'identity_mismatch',
          ] as const,
          'agent_failed',
        ),
      };
      const detail = optionalStr(msg, 'detail', 500);
      if (detail) out.detail = detail;
      return out;
    }

    case 'folder_put': {
      const out: FolderPutMessage = {
        t: 'folder_put',
        id: str(msg, 'id', 64),
        // `normalizeFolderPath` es lo que impide que un path escrito por un
        // miembro acabe escribiendo fuera de la carpeta en el disco ajeno.
        path: folderPath(msg),
        text: str(msg, 'text', LIMITS.folderText),
      };
      return out;
    }

    case 'folder_drop': {
      const out: FolderDropMessage = {
        t: 'folder_drop',
        id: str(msg, 'id', 64),
        path: folderPath(msg),
      };
      return out;
    }

    case 'folder_get': {
      const out: FolderGetMessage = {
        t: 'folder_get',
        id: str(msg, 'id', 64),
        path: folderPath(msg),
      };
      return out;
    }

    case 'ping':
      return {
        t: 'ping',
        quotaRemaining:
          msg.quotaRemaining === null || msg.quotaRemaining === undefined
            ? null
            : int(msg, 'quotaRemaining', 0, 1_000_000),
      };

    default:
      throw new ValidationError('t', `tipo de mensaje desconocido: ${msg.t}`);
  }
}

// Una persona puede exponer varios repositorios, y cada uno es un destino
// distinto: `@ana` es "cualquiera de los suyos" y `@ana:api` es ese en
// concreto. Sin esto el propio autocompletado del portal ofrecia destinos que
// el hub rechazaba.
const TAG = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function validateTarget(raw: string): AskMessage['to'] {
  if (raw === '@all' || raw === '@auto') return raw;

  const corte = raw.indexOf(':');
  if (corte < 0) return normalizeAlias(raw);

  const alias = normalizeAlias(raw.slice(0, corte));
  const tag = raw.slice(corte + 1).toLowerCase();
  if (!TAG.test(tag)) {
    throw new ValidationError('to', `etiqueta inválida en "${raw}"`);
  }
  return `${alias}:${tag}`;
}
