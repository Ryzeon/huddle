import { SessionStore } from '../application/session-store.js';
import type { FeedIdentity, RoomFeed } from '../application/ports/room-feed.js';
import { DemoRoomFeed } from '../adapters/outbound/demo-room-feed.js';
import { DEMO_ROOMS } from '../adapters/outbound/demo-script.js';
import { LocalRoomsStore, MemoryRoomsStore } from '../adapters/outbound/local-rooms-store.js';
import { WsRoomFeed } from '../adapters/outbound/ws-room-feed.js';
import { ChatView } from '../adapters/inbound/chat-view.js';
import { HeaderView } from '../adapters/inbound/header-view.js';
import { RoomsView, normalizeAlias } from '../adapters/inbound/rooms-view.js';
import { TableView } from '../adapters/inbound/table-view.js';
import { applyTheme, readTheme, toggleTheme, type Theme } from '../adapters/inbound/theme.js';
import { need } from '../adapters/inbound/dom.js';

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

function buildFeed(params: URLSearchParams): Setup {
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

  const identity: FeedIdentity = create
    ? { mode: 'create', room: '', roomName: create, alias, viewer: true }
    : { mode: 'join', room: room ?? '', alias, viewer: true };

  return {
    feed: new WsRoomFeed({ url: hub, identity }),
    demo: null,
    hub,
    alias,
  };
}

function navigateTo(params: Record<string, string>): void {
  const url = new URL(window.location.href);
  url.search = '';
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  window.location.assign(url.toString());
}

export function bootstrap(): void {
  const params = new URLSearchParams(window.location.search);

  // Apaga también las animaciones declarativas (CSS), no solo las de la mesa.
  if (params.has('estatico')) document.documentElement.dataset['estatico'] = '1';

  const forced = params.get('tema');
  const theme: Theme = forced === 'claro' || forced === 'oscuro' ? forced : readTheme();
  let current = theme;
  applyTheme(current);

  const { feed, demo, hub, alias } = buildFeed(params);
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
      onCreate: (room) => navigateTo({ hub: room.hub, crear: room.name, alias: room.alias }),
      onForget: (code) => rooms.forget(code),
    },
    { hub, alias },
  );

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

  let remembered: string | null = null;
  store.subscribe((state) => {
    header.render(state);
    table.render(state);
    chat.render(state);
    roomsView.render(state);
    empty.hidden = state.room !== null;
    if (salir) salir.hidden = state.room === null;
    // Solo al anfitrión, y comparando por alias: tu etiqueta puede llevar tag.
    if (cerrar) {
      cerrar.hidden =
        state.room === null || state.host === null || state.host !== state.you?.split(':')[0];
    }

    // Se recuerda una sola vez por sala: escribir en cada `room_state` sería
    // tocar `localStorage` decenas de veces por sesión sin ganar nada.
    if (state.room && state.room !== remembered && demo === null) {
      remembered = state.room;
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
  if (!document.hidden) chat.focus();

  window.addEventListener('beforeunload', () => store.stop());
}

bootstrap();
