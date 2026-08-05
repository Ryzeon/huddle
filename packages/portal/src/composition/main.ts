import { SessionStore } from '../application/session-store.js';
import type { FeedIdentity, RoomFeed } from '../application/ports/room-feed.js';
import { DemoRoomFeed } from '../adapters/outbound/demo-room-feed.js';
import { DEMO_ROOMS } from '../adapters/outbound/demo-script.js';
import { LocalRoomsStore, MemoryRoomsStore } from '../adapters/outbound/local-rooms-store.js';
import { WsRoomFeed } from '../adapters/outbound/ws-room-feed.js';
import {
  loadOrCreateIdentity,
  type PortalIdentity,
} from '../adapters/outbound/webcrypto-identity.js';
import { ChatView } from '../adapters/inbound/chat-view.js';
import { HeaderView } from '../adapters/inbound/header-view.js';
import { RoomsView, normalizeAlias } from '../adapters/inbound/rooms-view.js';
import { ApprovalsView } from '../adapters/inbound/approvals-view.js';
import { FolderView } from '../adapters/inbound/folder-view.js';
import { TableView } from '../adapters/inbound/table-view.js';
import { applyTheme, readTheme, toggleTheme, type Theme } from '../adapters/inbound/theme.js';
import { need } from '../adapters/inbound/dom.js';
import type { Upload } from '../domain/uploads.js';

const DEFAULT_HUB = 'ws://localhost:8787';

class IdleFeed implements RoomFeed {
  start(): void {}
  stop(): void {}
  send(): void {}
  subscribe(): () => void {
    return () => {};
  }
}

interface Setup {
  feed: RoomFeed;
  demo: DemoRoomFeed | null;
  hub: string;
  alias: string;
}

function buildFeed(params: URLSearchParams, signer: PortalIdentity | null): Setup {
  const hub = params.get('hub') ?? DEFAULT_HUB;
  const alias = normalizeAlias(params.get('alias') ?? '@visita') || '@visita';

  if (params.get('demo') !== null) {
    const speed = Number(params.get('velocidad') ?? '1');
    const instant = params.get('instante');
    const demo = new DemoRoomFeed({
      speed: Number.isFinite(speed) && speed > 0 ? speed : 1,
      ...(instant !== null
        ? { instant: true, untilMs: Number(instant) || Number.POSITIVE_INFINITY }
        : {}),
    });
    return { feed: demo, demo, hub, alias };
  }

  const room = params.get('sala');
  const create = params.get('crear');
  if (!room && !create) return { feed: new IdleFeed(), demo: null, hub, alias };

  // Una sala con aprobación exige firmar: sin Ed25519 en el navegador nace
  // abierta, y el hub rechazaría el `create` si dijéramos lo contrario.
  const policy = params.get('politica') === 'aprobada' && signer ? 'approved' : undefined;

  const identity: FeedIdentity = create
    ? {
        mode: 'create',
        room: '',
        roomName: create,
        alias,
        viewer: true,
        policy,
        // Lo elegido en el diálogo viaja por la URL, como el resto del estado
        // del portal: recargar tiene que llevar a la misma sala.
        folderWrite: params.get('carpeta') === 'host' ? 'host' : 'all',
        folderMemory: params.get('sin-memoria') === null,
      }
    : { mode: 'join', room: room ?? '', alias, viewer: true };

  return {
    feed: new WsRoomFeed({ url: hub, identity, signer }),
    demo: null,
    hub,
    alias,
  };
}

/**
 * La misma URL con otro código de sala. Tras rotar, recargar con `?crear=` o
 * con el código viejo llevaría a una sala que ya no existe.
 */
function urlFor(room: string): string {
  const url = new URL(window.location.href);
  url.searchParams.delete('crear');
  url.searchParams.set('sala', room);
  return url.toString();
}

/**
 * Lo que la sala nueva se llevará dentro en cuanto exista.
 *
 * Crear una sala navega a otra URL, y en esa navegación se pierde todo lo que
 * hubiera en memoria. `sessionStorage` es lo que sobrevive a una recarga y no
 * a cerrar la pestaña, que es exactamente la vida que tiene esto: si la sala
 * no llega a abrirse, no debe quedar nada esperando para siempre.
 */
const SEMILLA = 'huddle:carpeta-inicial';

interface Semilla {
  uploads: Upload[];
  rechazados: string[];
}

function guardarSemilla(semilla: Semilla): void {
  if (semilla.uploads.length === 0 && semilla.rechazados.length === 0) return;
  try {
    sessionStorage.setItem(SEMILLA, JSON.stringify(semilla));
  } catch {
    // Sin sitio o sin permiso: la sala se crea igual, vacía. Perder los
    // archivos es malo; no poder crear la sala, peor.
  }
}

/** Se lee una sola vez: al segundo intento ya no hay nada que sembrar. */
function tomarSemilla(): Semilla | null {
  try {
    const raw = sessionStorage.getItem(SEMILLA);
    if (!raw) return null;
    sessionStorage.removeItem(SEMILLA);
    return JSON.parse(raw) as Semilla;
  } catch {
    return null;
  }
}

function navigateTo(params: Record<string, string>): void {
  const url = new URL(window.location.href);
  url.search = '';
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  window.location.assign(url.toString());
}

export async function bootstrap(): Promise<void> {
  const params = new URLSearchParams(window.location.search);

  // Apaga también las animaciones declarativas (CSS), no solo las de la mesa.
  if (params.has('estatico')) document.documentElement.dataset['estatico'] = '1';

  const forced = params.get('tema');
  const theme: Theme = forced === 'claro' || forced === 'oscuro' ? forced : readTheme();
  let current = theme;
  applyTheme(current);

  // Sin Ed25519 en el navegador se entra sin firmar: solo a salas abiertas y
  // con el alias libre. Se dice en pantalla, no se disimula.
  const signer = await loadOrCreateIdentity();

  const { feed, demo, hub, alias } = buildFeed(params, signer);
  // En demo, las salas viven en memoria: mirar la demostración no debe
  // dejar rastro en el navegador de quien la mira.
  const rooms = demo ? new MemoryRoomsStore(DEMO_ROOMS) : new LocalRoomsStore();

  const tableHost = need<HTMLElement>('[data-mesa]');
  // `?estatico=1` apaga las animaciones sin tocar la preferencia del sistema:
  // es lo que hace deterministas las capturas.
  const table = new TableView(tableHost, {
    sinAnimacion: params.has('estatico'),
    onKick: (label) => store.kick(label),
  });

  const store = new SessionStore({
    feed,
    onActivity: (activity) => table.playActivity(activity),
  });

  const header = new HeaderView(need<HTMLElement>('[data-cabecera]'), {
    onCopyCode: (code) => {
      void navigator.clipboard
        ?.writeText(code)
        .then(() => header.flashCopied())
        .catch(() => store.note('el navegador no dejó copiar el código', 'failed'));
    },
    onToggleTheme: () => {
      current = toggleTheme(current);
      applyTheme(current);
    },
  });

  const chat = new ChatView(need<HTMLElement>('[data-chat]'), {
    onMessage: (text) => store.sendMessage(text),
    onAsk: (to, question) => store.ask(to, question),
    onInvalid: (reason) => store.note(reason, 'failed'),
  });

  const roomsView = new RoomsView(
    need<HTMLElement>('[data-salas]'),
    rooms,
    {
      onOpen: (room) => navigateTo({ hub: room.hub, sala: room.code, alias: room.alias }),
      onCreate: (room) => {
        guardarSemilla({ uploads: room.uploads, rechazados: room.rechazados });
        navigateTo({
          hub: room.hub,
          crear: room.name,
          alias: room.alias,
          ...(room.approved && { politica: 'aprobada' }),
          ...(room.folderHost && { carpeta: 'host' }),
          ...(room.folderMemory ? {} : { 'sin-memoria': '1' }),
        });
      },
      onForget: (code) => rooms.forget(code),
    },
    { hub, alias, canSign: signer !== null },
  );

  const puerta = document.querySelector<HTMLElement>('[data-puerta]');
  const approvals = puerta
    ? new ApprovalsView(puerta, {
        onAdmit: (id) => store.admit(id),
        onDeny: (id) => store.deny(id),
      })
    : null;

  const folderHost = document.querySelector<HTMLElement>('[data-carpeta]');
  const folder = folderHost
    ? new FolderView(folderHost, {
        onOpen: (path) => store.openFile(path),
        onClose: () => store.closeFile(),
        onWrite: (path, text) => store.writeFile(path, text),
        onWriteMany: (files) => store.writeFiles(files),
        onRemove: (path) => store.removeFile(path),
        onNote: (text) => store.note(text, 'failed'),
      })
    : null;

  const folderButton = document.querySelector<HTMLButtonElement>('[data-carpeta-abrir]');
  folderButton?.addEventListener('click', () => {
    folder?.toggle();
    folderButton.setAttribute('aria-expanded', String(folder?.isOpen ?? false));
  });

  const empty = need<HTMLElement>('[data-vacio]');
  const replay = need<HTMLButtonElement>('[data-repetir]');
  replay.hidden = demo === null;
  replay.addEventListener('click', () => {
    if (!demo) return;
    window.location.reload();
  });

  // Salir es dejar de estar: se corta la conexión y se vuelve al portal sin
  // sala. La sala sigue recordada en el lateral para poder volver.
  const salir = document.querySelector<HTMLButtonElement>('[data-salir]');
  salir?.addEventListener('click', () => {
    feed.stop();
    window.location.href = window.location.pathname;
  });

  // Cerrar es irreversible: se borra la sala y su historial. Por eso pide
  // confirmación en dos toques, igual que expulsar, y no un `confirm()` del
  // navegador, que bloquea la página entera.
  const cerrar = document.querySelector<HTMLButtonElement>('[data-cerrar-sala]');
  let armado = false;
  let desarmar: ReturnType<typeof setTimeout> | undefined;
  cerrar?.addEventListener('click', () => {
    if (armado) {
      clearTimeout(desarmar);
      store.closeRoom();
      return;
    }
    armado = true;
    cerrar.textContent = '¿seguro? se borra todo';
    cerrar.classList.add('boton--peligro');
    desarmar = setTimeout(() => {
      armado = false;
      cerrar.textContent = 'cerrar sala';
      cerrar.classList.remove('boton--peligro');
    }, 4_000);
  });

  // Rotar también echa a todo el mundo, así que también va en dos toques.
  const rotar = document.querySelector<HTMLButtonElement>('[data-rotar-codigo]');
  let rotarArmado = false;
  let desarmarRotar: ReturnType<typeof setTimeout> | undefined;
  rotar?.addEventListener('click', () => {
    if (rotarArmado) {
      clearTimeout(desarmarRotar);
      rotarArmado = false;
      rotar.textContent = 'cambiar código';
      rotar.classList.remove('boton--peligro');
      store.rotateCode();
      return;
    }
    rotarArmado = true;
    rotar.textContent = '¿seguro? echa a todos';
    rotar.classList.add('boton--peligro');
    desarmarRotar = setTimeout(() => {
      rotarArmado = false;
      rotar.textContent = 'cambiar código';
      rotar.classList.remove('boton--peligro');
    }, 4_000);
  });

  // La carpeta inicial se siembra cuando la sala ya existe: antes del welcome
  // no hay a dónde escribir, y el hub rechazaría los `folder_put`.
  const semilla = tomarSemilla();
  let sembrado = false;

  let remembered: string | null = null;
  store.subscribe((state) => {
    if (semilla && !sembrado && state.room !== null) {
      sembrado = true;
      store.writeFiles(semilla.uploads);
      for (const motivo of semilla.rechazados) store.note(motivo, 'failed');
      if (semilla.uploads.length > 0) {
        store.note(
          `${semilla.uploads.length} archivo(s) en la carpeta de la sala: los leerá el agente de todos`,
        );
      }
    }

    header.render(state);
    table.render(state);
    chat.render(state);
    roomsView.render(state);
    approvals?.render(state);
    folder?.render(state);
    if (folderButton) {
      folderButton.hidden = state.room === null;
      // El número va en el botón: es lo que hace que se note que hay algo
      // nuevo sin tener que abrirlo.
      folderButton.textContent =
        state.folder.length > 0 ? `carpeta · ${state.folder.length}` : 'carpeta';
      folderButton.setAttribute('aria-expanded', String(folder?.isOpen ?? false));
    }
    empty.hidden = state.room !== null;
    if (salir) salir.hidden = state.room === null;
    // Solo al anfitrión, y comparando por alias: tu etiqueta puede llevar tag.
    if (cerrar) {
      cerrar.hidden =
        state.room === null || state.host === null || state.host !== state.you?.split(':')[0];
    }
    if (rotar) rotar.hidden = cerrar ? cerrar.hidden : true;

    // Se recuerda una sola vez por sala: escribir en cada `room_state` sería
    // tocar `localStorage` decenas de veces por sesión sin ganar nada.
    if (state.room && state.room !== remembered && demo === null) {
      // Tras rotar, el código viejo en el lateral no abre nada: se olvida antes
      // de recordar el nuevo, o la lista se llena de puertas muertas.
      if (remembered) rooms.forget(remembered);
      remembered = state.room;
      history.replaceState(null, '', urlFor(state.room));
      rooms.remember({
        code: state.room,
        name: state.roomName ?? state.room,
        alias: state.you ?? alias,
        hub,
        lastSeen: Date.now(),
      });
    }
  });

  store.start();
  if (!signer && demo === null) {
    store.note(
      'este navegador no puede firmar tu alias: entras sin firmar, y solo donde el alias esté libre',
      'failed',
    );
  }
  if (!document.hidden) chat.focus();

  window.addEventListener('beforeunload', () => store.stop());
}

void bootstrap();
