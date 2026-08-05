/**
 * Lector de ZIP, lo justo para vaciar uno en la carpeta de la sala.
 *
 * Sin dependencias: el navegador ya sabe inflar (`DecompressionStream`), y lo
 * único que falta es leer la estructura del archivo. El portal no lleva
 * bundler ni una sola dependencia de runtime, y meter una librería de 40 KB
 * para esto sería cambiar el sistema entero por una comodidad.
 *
 * Se leen los dos métodos que usa todo el mundo —guardado y deflate— y se
 * ignora el resto. Un zip cifrado, partido en volúmenes o en zip64 no es lo
 * que alguien arrastra a la carpeta de un equipo.
 */

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

/** El comentario final cabe en 64 KB, así que el EOCD no está más atrás. */
const MAX_EOCD_SCAN = 65_557;

/**
 * Topes contra un zip que se descomprime en algo enorme.
 *
 * Un archivo de 2 KB puede declarar gigabytes al inflarse, y el navegador de
 * quien lo arrastra se lo comería entero. Se corta por lo que el propio índice
 * declara, antes de descomprimir nada.
 */
export const ZIP_LIMITS = {
  entries: 200,
  totalBytes: 8_000_000,
} as const;

export interface ZipEntry {
  /** La ruta tal cual venía dentro del zip. */
  name: string;
  text: string;
}

export interface ZipResult {
  entries: ZipEntry[];
  /** Lo que no se sacó, con el motivo, para poder contarlo. */
  rechazados: string[];
}

export async function readZip(buffer: ArrayBuffer): Promise<ZipResult> {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const eocd = findEocd(view);
  if (eocd < 0) throw new Error('no parece un archivo zip');

  const total = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);

  const entries: ZipEntry[] = [];
  const rechazados: string[] = [];
  let acumulado = 0;

  for (let i = 0; i < total && i < ZIP_LIMITS.entries; i++) {
    if (offset + 46 > view.byteLength) break;
    if (view.getUint32(offset, true) !== CENTRAL_SIGNATURE) break;

    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);

    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    offset += 46 + nameLength + extraLength + commentLength;

    // Las carpetas del zip son entradas vacías acabadas en barra: no hay nada
    // que sacar de ellas, y la estructura ya viene en el nombre de cada archivo.
    if (name.endsWith('/')) continue;

    if (method !== 0 && method !== 8) {
      rechazados.push(`${name} usa una compresión que no se lee`);
      continue;
    }

    acumulado += uncompressedSize;
    if (acumulado > ZIP_LIMITS.totalBytes) {
      rechazados.push(`${name} no entra: el zip descomprimido pasa de los 8 MB`);
      break;
    }

    const data = await extract(view, bytes, localOffset, method, compressedSize);
    if (!data) {
      rechazados.push(`no se pudo descomprimir ${name}`);
      continue;
    }

    entries.push({ name, text: new TextDecoder().decode(data) });
  }

  return { entries, rechazados };
}

/**
 * El EOCD se busca hacia atrás porque su posición depende del comentario
 * final, que es de longitud libre. No hay otra forma: el formato se lee desde
 * el final.
 */
function findEocd(view: DataView): number {
  const from = Math.max(0, view.byteLength - MAX_EOCD_SCAN);
  for (let at = view.byteLength - 22; at >= from; at--) {
    if (view.getUint32(at, true) === EOCD_SIGNATURE) return at;
  }
  return -1;
}

/**
 * Los datos de un archivo.
 *
 * El tamaño del nombre y del extra se leen de la cabecera LOCAL, no de la
 * central: los dos existen y no siempre coinciden, y usar el de la central
 * deja el desplazamiento corrido y el archivo ilegible.
 */
async function extract(
  view: DataView,
  bytes: Uint8Array,
  localOffset: number,
  method: number,
  compressedSize: number,
): Promise<Uint8Array | null> {
  if (localOffset + 30 > view.byteLength) return null;
  if (view.getUint32(localOffset, true) !== LOCAL_SIGNATURE) return null;

  const nameLength = view.getUint16(localOffset + 26, true);
  const extraLength = view.getUint16(localOffset + 28, true);
  const start = localOffset + 30 + nameLength + extraLength;
  const raw = bytes.subarray(start, start + compressedSize);

  if (method === 0) return raw;

  try {
    // `deflate-raw`: dentro de un zip no hay cabecera zlib, solo el bloque.
    // La copia es para que el `Blob` reciba un `ArrayBuffer` suyo: `subarray`
    // devuelve una vista sobre el buffer del zip entero.
    const stream = new Blob([new Uint8Array(raw).slice().buffer])
      .stream()
      .pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}
