import { readFileSync } from 'node:fs';
import type { FolderEntry } from '@huddle/protocol';
import { callControl } from '../control-server.js';
import { fail } from './io.js';

interface FolderListing {
  dir?: string;
  files: FolderEntry[];
}

/**
 * `huddle folder [ls|cat|put|rm]`.
 *
 * `put` acepta el contenido por argumento o por la entrada estándar, que es lo
 * que permite `cat notas.md | huddle folder put notas/x.md` sin tener que
 * escapar nada.
 */
export async function runFolder(args: string[]): Promise<void> {
  const [action = 'ls', ...rest] = args;

  switch (action) {
    case 'ls':
      return list();
    case 'cat':
      return cat(rest[0]);
    case 'put':
      return put(rest);
    case 'rm':
      return remove(rest[0]);
    default:
      fail(`no sé qué es "folder ${action}". Usa: ls | cat <ruta> | put <ruta> | rm <ruta>`);
  }
}

async function list(): Promise<void> {
  const response = await callControl({ op: 'folder_list' });
  if (!response.ok) fail(response.error);

  const { dir, files } = response.data as FolderListing;
  if (files.length === 0) {
    console.log('La carpeta de la sala está vacía.');
    if (dir) console.log(`Se sincroniza en ${dir}`);
    return;
  }

  const ancho = Math.max(...files.map((file) => file.path.length));
  for (const file of files) {
    console.log(
      `${file.path.padEnd(ancho)}  ${String(Math.ceil(file.size / 1024)).padStart(4)} KB  ${file.by}`,
    );
  }
  if (dir) console.log(`\n${files.length} archivo(s) · sincronizados en ${dir}`);
}

async function cat(path: string | undefined): Promise<void> {
  if (!path) fail('falta la ruta: huddle folder cat <ruta>');

  const response = await callControl({ op: 'folder_read', path });
  if (!response.ok) fail(response.error);
  process.stdout.write((response.data as { text: string }).text);
}

async function put(args: string[]): Promise<void> {
  const [path, ...rest] = args;
  if (!path) fail('falta la ruta: huddle folder put <ruta> ["contenido"]');

  const text = rest.length > 0 ? rest.join(' ') : readStdin();
  if (!text.trim()) {
    fail('no hay nada que escribir: pásalo como argumento o por la entrada estándar');
  }

  const response = await callControl({ op: 'folder_write', path, text });
  if (!response.ok) fail(response.error);
  console.log(`Escrito ${(response.data as { path: string }).path} en la carpeta de la sala.`);
}

async function remove(path: string | undefined): Promise<void> {
  if (!path) fail('falta la ruta: huddle folder rm <ruta>');

  const response = await callControl({ op: 'folder_remove', path });
  if (!response.ok) fail(response.error);
  console.log(`Borrado ${path} de la carpeta de la sala.`);
}

/** Sin nada por tubería, `readFileSync(0)` lanza; eso es no haber escrito nada. */
function readStdin(): string {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}
