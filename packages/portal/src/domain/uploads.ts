/**
 * Archivos que entran en la carpeta de la sala desde el navegador.
 *
 * Lo usan dos sitios: el diálogo de crear sala —para que nazca con su material
 * dentro— y el panel de la carpeta. La regla de qué entra y con qué nombre
 * tiene que ser la misma en los dos, o el mismo archivo se llamaría distinto
 * según por dónde se metiera.
 *
 * No toca el DOM: `File` es de la plataforma, no del documento.
 */

import { readZip } from './zip.js';

/**
 * Tope por archivo. Por debajo del límite del protocolo (256 KB) para que algo
 * que aquí pasa no lo rechace el hub después, ya a medio subir.
 */
export const MAX_UPLOAD_BYTES = 240_000;

export interface Upload {
  path: string;
  text: string;
}

export interface UploadResult {
  ok: Upload[];
  /** Por qué no entró cada uno, en palabras que se le puedan enseñar a alguien. */
  rechazados: string[];
}

export async function readUploads(
  files: Iterable<File>,
  prefix = 'notas/',
): Promise<UploadResult> {
  const ok: Upload[] = [];
  const rechazados: string[] = [];

  for (const file of files) {
    if (isZip(file)) {
      const salida = await expandZip(file, prefix);
      ok.push(...salida.ok);
      rechazados.push(...salida.rechazados);
      continue;
    }

    if (file.size > MAX_UPLOAD_BYTES) {
      rechazados.push(
        `${file.name} pesa demasiado (máximo ${Math.round(MAX_UPLOAD_BYTES / 1000)} KB)`,
      );
      continue;
    }

    let text: string;
    try {
      text = await file.text();
    } catch {
      rechazados.push(`no se pudo leer ${file.name}`);
      continue;
    }

    const motivo = rejectText(text, file.name);
    if (motivo) {
      rechazados.push(motivo);
      continue;
    }

    ok.push({ path: `${prefix}${safeName(file.name)}`, text });
  }

  return { ok, rechazados };
}

function isZip(file: File): boolean {
  return file.name.toLowerCase().endsWith('.zip') || file.type === 'application/zip';
}

/**
 * Vacía un zip en la carpeta.
 *
 * Es la forma de meter algo con forma —una carpeta de documentación, un
 * puñado de decisiones— sin ir archivo por archivo. Se conserva la estructura
 * de dentro, porque es la que le da sentido: `docs/api.md` sigue estando bajo
 * `docs/`.
 */
async function expandZip(file: File, prefix: string): Promise<UploadResult> {
  const ok: Upload[] = [];
  const rechazados: string[] = [];

  let leido;
  try {
    leido = await readZip(await file.arrayBuffer());
  } catch (error) {
    return {
      ok: [],
      rechazados: [`${file.name}: ${error instanceof Error ? error.message : 'no se pudo abrir'}`],
    };
  }

  rechazados.push(...leido.rechazados);

  for (const entry of leido.entries) {
    // Lo que el empaquetador metió por su cuenta se descarta sin ruido: quien
    // arrastró el zip no sabe que existe y no puede hacer nada al respecto.
    const path = safePath(entry.name);
    if (!path) continue;

    const motivo = rejectText(entry.text, entry.name);
    if (motivo) {
      rechazados.push(motivo);
      continue;
    }
    ok.push({ path: `${prefix}${path}`, text: entry.text });
  }

  if (ok.length === 0 && rechazados.length === 0) {
    rechazados.push(`${file.name} no traía ningún archivo de texto`);
  }

  return { ok, rechazados };
}

/** Por qué no entra un texto, o `null` si entra. */
function rejectText(text: string, name: string): string | null {
  if (text.length > MAX_UPLOAD_BYTES) {
    return `${name} pesa demasiado (máximo ${Math.round(MAX_UPLOAD_BYTES / 1000)} KB)`;
  }
  if (text.includes('\u0000') || text.includes('\ufffd')) {
    return `${name} no es texto: la carpeta es para lo que se lee`;
  }
  if (!text.trim()) return `${name} está vacío`;
  return null;
}

/**
 * Profundidad que se conserva de dentro del zip.
 *
 * El hub corta en seis niveles y uno lo gasta el prefijo, así que quedan
 * cuatro. Lo que venga más hondo se aplana al nombre del archivo: perder la
 * carpeta es mejor que perder el archivo.
 */
const MAX_ZIP_DEPTH = 4;

/**
 * La ruta de algo que venía dentro de un zip, o `null` si no debe entrar.
 *
 * Devuelve `null` en vez de inventarse un nombre: los `__MACOSX/._x` de macOS
 * son metadatos binarios, y meterlos como «archivo.md» llenaría la carpeta del
 * equipo de basura con nombre de nota.
 */
export function safePath(raw: string): string | null {
  const partes = raw
    .replace(/\\/g, '/')
    .split('/')
    .filter((segmento) => segmento && segmento !== '.' && segmento !== '..');

  // Basura del empaquetador: la carpeta `__MACOSX` y los AppleDouble `._algo`.
  if (partes.some((parte) => parte === '__MACOSX' || parte.startsWith('._'))) return null;

  const segmentos = partes.map(safeName).filter(Boolean);
  if (segmentos.length === 0) return null;
  if (segmentos.length > MAX_ZIP_DEPTH) return segmentos[segmentos.length - 1]!;
  return segmentos.join('/');
}

/**
 * Un nombre de archivo que la carpeta acepte.
 *
 * Los nombres del disco traen espacios, acentos y paréntesis, y el hub los
 * rechaza. Se sanean aquí en vez de dejar que falle la subida: quien arrastra
 * un archivo quiere que entre, no aprender las reglas de nombres.
 */
export function safeName(raw: string): string {
  const clean = raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^[-.]+/, '')
    .replace(/-+/g, '-')
    // «Notas (final).md» dejaría un guion colgando antes del punto.
    .replace(/-+\./g, '.')
    .replace(/-+$/, '')
    .slice(0, 64);
  return clean || 'archivo.md';
}
