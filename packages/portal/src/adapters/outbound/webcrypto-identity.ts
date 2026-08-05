/**
 * La clave con la que el portal firma su alias.
 *
 * La privada se genera no extraíble y se guarda en IndexedDB como
 * `CryptoKey`: el navegador la usa para firmar pero no la deja leer, ni
 * siquiera a este código. Borrar los datos del sitio la pierde, y entonces el
 * hub ve otra clave; por eso el error de identidad explica cómo salir.
 *
 * Si el navegador no trae Ed25519 se devuelve `null` y se entra sin firmar.
 */

const DB_NAME = 'huddle';
const STORE = 'identidad';
const KEY_ID = 'ed25519';

export interface PortalIdentity {
  publicKey: string;
  sign(text: string): Promise<string>;
}

interface StoredPair {
  publicKey: CryptoKey;
  privateKey: CryptoKey;
}

export async function loadOrCreateIdentity(): Promise<PortalIdentity | null> {
  if (!globalThis.crypto?.subtle || !globalThis.indexedDB) return null;

  try {
    const existing = await read();
    const pair = existing ?? (await create());
    if (!pair) return null;

    const raw = await crypto.subtle.exportKey('raw', pair.publicKey);
    const publicKey = base64url(new Uint8Array(raw));

    return {
      publicKey,
      sign: async (text) => {
        const sig = await crypto.subtle.sign(
          'Ed25519',
          pair.privateKey,
          new TextEncoder().encode(text),
        );
        return base64url(new Uint8Array(sig));
      },
    };
  } catch {
    return null;
  }
}

async function create(): Promise<StoredPair | null> {
  let pair: CryptoKeyPair;
  try {
    // `false` = privada no extraíble. Es lo único que impide que un XSS se
    // lleve la identidad en vez de solo usarla mientras dura la pestaña.
    pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, false, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
  } catch {
    return null; // navegador sin Ed25519
  }

  const stored: StoredPair = { publicKey: pair.publicKey, privateKey: pair.privateKey };
  await write(stored);
  return stored;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('no se pudo abrir IndexedDB'));
  });
}

async function read(): Promise<StoredPair | null> {
  const db = await openDb();
  return new Promise((resolve) => {
    const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(KEY_ID);
    request.onsuccess = () => resolve((request.result as StoredPair | undefined) ?? null);
    request.onerror = () => resolve(null);
  });
}

async function write(pair: StoredPair): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(pair, KEY_ID);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
