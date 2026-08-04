# @huddle/portal

La cara web de una sala de Huddle: **una mesa** con quién está sentado, **el chat
de sesión** con todo lo que pasa, y **las salas** a las que estás conectado.

El portal entra siempre como **espectador** (`viewer: true`): mira, y si quieres
puede preguntar, pero nunca responde por ti. Quien responde es tu daemon, desde
tu repositorio y con tu cuenta.

Las animaciones de pregunta y respuesta las dispara `activity`, que **no lleva
el contenido**: en la mesa se ve quién le preguntó a quién y cuánto tardó, nunca
qué se dijo. El texto de una respuesta solo lo ve quien preguntó.

![la mesa, tema oscuro](preview/oscuro.png)

---

## Arranque

```bash
npm install                      # desde la raíz del monorepo
npm run portal                   # o: npm run dev -w @huddle/portal
```

Levanta `http://127.0.0.1:5173` y compila en watch. Sin bundler y sin ninguna
petición de red que no salga de este repositorio.

```bash
# ver una sesión completa de mentira, sin hub ninguno
open 'http://127.0.0.1:5173/?demo=1'

# contra un hub de verdad
open 'http://127.0.0.1:5173/?hub=ws://localhost:8787&sala=MPP8V-7HZS5&alias=@ana'

# crear una sala nueva en ese hub
open 'http://127.0.0.1:5173/?hub=ws://localhost:8787&crear=plataforma&alias=@ana'
```

### Parámetros de la URL

| Parámetro | Para qué |
|---|---|
| `demo=1` | reproduce el guion de demostración; no toca la red ni `localStorage` |
| `velocidad=3` | el guion, tres veces más rápido |
| `instante=8000` | salta al estado del guion en ese milisegundo, sin esperas |
| `hub=ws://host:8787` | dónde está el hub |
| `sala=CÓDIGO` | a qué sala entrar |
| `crear=nombre` | crear una sala en vez de entrar a una |
| `alias=@ana` | con qué alias apareces |
| `tema=claro\|oscuro` | fuerza el tema |
| `estatico=1` | apaga todas las animaciones (para capturas deterministas) |

La URL **es** el estado: una sala se puede pegar en un chat y funciona.

---

## Modo demo

`?demo=1` reproduce `src/adapters/outbound/demo-script.ts`: entran tres personas,
se cruzan cuatro preguntas —una de caché, una que falla—, se va la anfitriona y
el mando cambia de manos. Veintitrés segundos.

Existe porque el portal se escribió **antes** que el `activity` y el `viewer` del
hub: era la única forma de ver y ajustar las animaciones. Ahora se queda como
banco de pruebas, y el guion tiene sus propios tests (que se abra y se cierre
cada pregunta, que nadie se pregunte a sí mismo, que el estado final sea
coherente): si deja de contar una historia posible, salta un test.

La caja de escribir también funciona en demo: los mensajes se hacen eco y un
`/ask @alias …` devuelve una respuesta de pega con sus fuentes.

### Capturas

```bash
npm run shots -w @huddle/portal     # con el portal levantado
```

Deja en `preview/` los seis estados que hay que mirar antes de tocar nada:

| Archivo | Qué enseña |
|---|---|
| `oscuro.png` · `claro.png` | la sala en marcha, una pregunta en vuelo, los dos temas |
| `respuesta.png` | el arco de vuelta, en verde señal, con el tiempo |
| `portatil.png` | 1280×760 — que quepa en un portátil, no solo en un monitor |
| `estrecho.png` | 860 px — la mesa arriba y el chat debajo |
| `sin-animacion.png` | con `prefers-reduced-motion` |
| `vacio.png` | sin sala: lo primero que ve quien abre el portal a pelo |

---

## Decisiones

**Sin framework y sin bundler.** TypeScript emite ESM con extensiones `.js`
explícitas —lo que ya exige `module: NodeNext`— y eso el navegador lo carga tal
cual. Del paquete `protocol` solo se importan **tipos**, que desaparecen al
compilar, así que en el navegador no queda ni un import sin resolver. El
servidor de desarrollo (`scripts/dev.ts`) es un `http.createServer` que sirve
`public/`, `dist/` y `brand/`, y lanza `tsc --build --watch` al lado. Cero
dependencias de ejecución.

**La misma forma que `hub` y `agent`.** `domain/` es geometría y reducción de
eventos, sin DOM ni sockets; `application/` tiene el puerto `RoomFeed` y el
caso de uso (`SessionStore`); `adapters/` tiene las dos implementaciones del
puerto —WebSocket y guion— y las vistas; `composition/main.ts` es el único
sitio que decide cuál se usa, leyendo la URL. Las vistas no saben si detrás hay
un hub.

**El hub manda rosters, no eventos de entrada y salida.** «Entró @fulano» se
deduce diffeando el roster nuevo contra el anterior, en `session-state.ts`. Es
la pieza que se rompe en silencio si se toca sin test, y por eso es la más
probada.

**La mesa se dibuja con la marca.** El nodo de cada miembro **es el símbolo de
Huddle** —los dos prompts enfrentados— en un solo color. No se usa un logo de
Claude ni de ninguna otra IA: no tengo el activo, y reproducirlo de memoria
sería peor que no ponerlo. El símbolo, además, significa exactamente lo que hay
que decir: alguien con un prompt, mirando al centro.

**Un solo ámbar.** La regla de `brand/marca.md` §3 se aplica en serio: el ámbar
es la celda del centro de la mesa (la pregunta compartida), el arco de la
pregunta viva, el cursor y el foco. Nada más. El anfitrión, la sala activa y el
botón de crear se marcan con contraste de tinta/papel, no con un segundo
acento. Los tres tonos de superficie de la hoja de estilos son mezclas del
propio carbón o papel: no introducen tinte nuevo.

**Las animaciones son un camino, no un estado.** Cada elemento se deja **ya** en
su aspecto final y `element.animate()` solo dibuja el trayecto hasta él, sin
`fill: forwards`. Los borrados van por temporizador, no por el evento `finish`.
Así, si el motor de animación no arranca —una captura headless, una pestaña en
segundo plano, `prefers-reduced-motion`—, lo que se ve sigue siendo correcto en
vez de quedarse invisible.

**Los estados no se distinguen solo por color.** Espectador = disco sin relleno
y borde discontinuo; anfitrión = borde grueso a tinta plena; respondiendo =
anillo; fallo = trazo más grueso y etiqueta «sin respuesta». Con
`prefers-reduced-motion` no se anima nada y todo eso sigue leyéndose.

**Tipografía.** La marca pide JetBrains Mono, pero no se puede descargar por red
y no quise meter un `.woff2` de 200 kB sin que nadie lo pidiera. Se usa la pila
mono del sistema (`ui-monospace…`), con JetBrains Mono declarada por si está
instalada. Ponerla de verdad es dejar el archivo en `public/fuentes/` y añadir
un `@font-face`.

**Las salas son memoria del navegador.** El hub no tiene cuentas: el código de
sala **es** la llave. Así que «mis salas» es una lista en `localStorage`
(`LocalRoomsStore`), y por eso la cabecera insiste tanto con el botón de copiar
el código. En demo se usa una lista en memoria: mirar la demostración no debe
dejar rastro.

---

## Conexión con el hub

`viewer` y `activity` ya están en `@huddle/protocol`, así que el portal importa
sus tipos de allí y no queda nada por acordar. Comprobado contra el hub real,
con tres agentes de mentira y el portal entrando de espectador:

- el `join` con `viewer: true` se acepta y el roster devuelve `viewer: true`;
- el espectador recibe las dos fases de `activity` (`asking` y `answered`, con
  `elapsedMs` y `cached`);
- y **no** recibe ningún `request`: el ruteo no le manda preguntas.

Lo que sigue pendiente:

- El hub no distingue **quién expulsó a quién**: a la sala solo le llega un
  `room_state` sin el que falta. El portal lo cuenta como «salió», y solo dice
  «te expulsaron» cuando el `room_closed` es tuyo.
- `GET /rooms/:code/transcript` no se usa todavía. Sería lo que rellena el chat
  al entrar a mitad de sesión, en vez de empezar en blanco.
- La mesa es un `role="img"` con etiqueta fija: quien use lector de pantalla se
  entera de las entradas y salidas por el chat (`role="log"`), no por la mesa.

## Desarrollo

```bash
npx tsc --build            # desde la raíz; limpio
npm test                   # 239 tests en total, 88 de este paquete
npm run shots -w @huddle/portal
```

Se prueba la lógica pura, no las animaciones:

- `domain/table-layout` — reparto alrededor de la mesa, estabilidad del orden,
  recorte de los trazos y la curva que esquiva el tablero.
- `domain/session-state` — el diff del roster, las fases de `activity`, el
  cambio de anfitrión, la ventana del hilo.
- `domain/chat-log` — cómo se redacta cada tipo de entrada, y que una respuesta
  ajena **no** lleve contenido.
- `domain/composer` — menciones con `@`, ranking del autocompletado, `/ask`.
- `adapters/outbound/demo-script` — que el guion sea una sesión posible.
