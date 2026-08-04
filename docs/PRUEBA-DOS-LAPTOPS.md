# Prueba con dos laptops

Objetivo: que desde la laptop **A** le preguntes al Claude de la laptop **B**
sobre un repositorio que **solo existe en B**. Si eso funciona, el producto
funciona; todo lo demás es pulido.

Toma unos 15 minutos.

---

## Antes de empezar

**En las dos laptops:**

- Node 20 o superior → `node --version`
- Si una es **Windows**, usa los lanzadores `.cmd` (`huddle.cmd`,
  `huddle-hub.cmd`) en lugar de `./huddle`. Todo lo demás es igual.
- Claude Code instalado y con sesión iniciada → `claude --version` y luego
  `claude auth status` (o simplemente abre `claude` y comprueba que responde)
- **Las dos en la misma red.** Mismo wifi, o las dos en el mismo hotspot.

**Importante:** cada laptop debe exponer un **repositorio distinto**. Si las
dos apuntan al mismo código, la prueba no demuestra nada — la gracia es que A
pregunte por código que A no tiene.

---

## Paso 1 — Llevar el código a la laptop B

En la laptop **A**, desde la carpeta del proyecto:

```bash
cd ~/Development/@Cosas-IA/huddle
tar --exclude=node_modules --exclude=dist --exclude=.git \
    -czf ~/Desktop/huddle.tar.gz .
```

Pasa `~/Desktop/huddle.tar.gz` a la laptop B por AirDrop (o USB, o lo que
prefieras).

En la laptop **B**:

En **macOS o Linux**:

```bash
mkdir -p ~/huddle && cd ~/huddle
tar -xzf ~/Downloads/huddle.tar.gz
npm install          # compila solo, vía el script `prepare`
./huddle             # debe imprimir la ayuda, no un error de módulo
```

En **Windows** (PowerShell). No uses `./huddle`: es un script de bash y
Windows te ofrecerá elegir una aplicación para abrirlo — cancela ese diálogo.

```powershell
mkdir $HOME\huddle; cd $HOME\huddle
tar -xzf $HOME\Downloads\huddle.tar.gz
npm install
.\huddle.cmd        # debe imprimir la ayuda
```

> `tar` viene incluido en Windows 10 y 11. Si no lo tienes, descomprime el
> `.tar.gz` con 7-Zip.

---

## Paso 2 — Levantar el hub (solo en la laptop A)

```bash
cd ~/Development/@Cosas-IA/huddle
HUDDLE_TOKEN=cambia-esto-por-algo-tuyo ./huddle-hub
```

Deja esa terminal abierta. Debe decir:

```
hub escuchando en ws://0.0.0.0:8787 (con token)
```

> **Si macOS pregunta** si quieres permitir conexiones entrantes para `node`,
> dile que **sí**. Si no, la laptop B no podrá conectarse.

**Anota la IP de la laptop A**, que la necesitarás en la B:

```bash
ipconfig getifaddr en0
```

En este momento es `172.20.10.4`, pero **cambia cada vez que te reconectas a
otra red** — vuelve a mirarla si algo no conecta.

Comprueba desde la laptop **B** que llega:

```bash
curl http://172.20.10.4:8787/health
# {"ok":true,"rooms":0,"members":0}
```

Si eso no responde, no sigas: es un problema de red o firewall, no del
programa. Ve a *Problemas* abajo.

---

## Paso 3 — Unir la laptop A a la sala

En una terminal **nueva** de la laptop A (el hub se queda en la suya):

```bash
cd ~/tu/proyecto-cualquiera        # el repo que quieres exponer desde A
~/Development/@Cosas-IA/huddle/huddle join prueba @ryzeon \
  --hub ws://172.20.10.4:8787 \
  --token cambia-esto-por-algo-tuyo \
  --quota 10

~/Development/@Cosas-IA/huddle/huddle daemon
```

Deja el daemon corriendo. Debe decir `conectado a … — sala #prueba`.

---

## Paso 4 — Unir la laptop B a la sala

En la laptop B, **desde el repositorio que quieras exponer** (uno que A no
tenga):

macOS o Linux:

```bash
cd ~/tu/otro-proyecto
~/huddle/huddle join prueba @laptop2 \
  --hub ws://172.20.10.4:8787 \
  --token cambia-esto-por-algo-tuyo \
  --quota 10

~/huddle/huddle daemon
```

Windows (PowerShell) — fíjate en `--cwd`, porque conviene ser explícito con
el repositorio que expones:

```powershell
& $HOME\huddle\huddle.cmd join prueba @laptop2 `
  --hub ws://172.20.10.4:8787 `
  --token cambia-esto-por-algo-tuyo `
  --cwd C:\ruta\a\tu\otro-proyecto `
  --quota 10

& $HOME\huddle\huddle.cmd daemon
```

---

## Paso 5 — La prueba

Desde la laptop **A**, en otra terminal:

```bash
cd ~/Development/@Cosas-IA/huddle
./huddle who
```

Deben aparecer los dos, con el repositorio de cada uno:

```json
[
  { "alias": "@ryzeon",  "repo": "proyecto-cualquiera", "status": "online", "quotaRemaining": 10 },
  { "alias": "@laptop2", "repo": "otro-proyecto",       "status": "online", "quotaRemaining": 10 }
]
```

Ahora la pregunta de verdad — **algo que solo esté en el repo de B**:

```bash
./huddle ask @laptop2 "Que hace este proyecto y cual es su archivo de entrada?"
```

Tarda entre 10 y 60 segundos. Si responde citando archivos del repositorio de
B, con su SHA al final: **funciona**.

```
Este proyecto es … El punto de entrada es src/main.ts.

Fuentes:
  src/main.ts:1
  package.json:5

— @laptop2 · @a1b2c3d · high · 18s
```

Prueba también:

```bash
# La misma pregunta otra vez: debe salir en menos de un segundo y decir "cacheado"
./huddle ask @laptop2 "que hace este proyecto y cual es su archivo de entrada"

# Que el hub elija a quién preguntar según el repositorio de cada uno
./huddle ask @auto "..."

# Preguntar a toda la sala a la vez
./huddle ask @all "en que estas trabajando?"
```

---

## Paso 6 — Desde dentro de Claude Code (la UX real)

Hasta aquí usaste la terminal. Esto es lo que de verdad quieres: preguntar
desde tu sesión de Claude.

En la laptop **A**:

```bash
claude mcp add huddle -- /Users/ryzeon/Development/@Cosas-IA/huddle/huddle mcp
```

> La ruta tiene que ser **absoluta**. En la laptop B sería `~/huddle/huddle`,
> escrito completo.

Abre `claude` y pídele algo como:

> Usa room_who para ver quién está en la sala, y luego pregúntale a @laptop2
> qué hace su proyecto.

Debería llamar a `room_who` y a `room_ask` y traerte la respuesta con sus
fuentes.

Para quitarlo después: `claude mcp remove huddle`.

---

## Qué estás comprobando exactamente

Marca cada uno; si alguno falla, eso es lo que hay que arreglar:

- [ ] Las dos laptops se ven en `room_who` con su repositorio correcto
- [ ] Una responde sobre código que la otra **no tiene**
- [ ] La respuesta trae fuentes reales y el SHA del repositorio
- [ ] La segunda vez sale de caché (menos de 1s) y **no descuenta cuota**
- [ ] La cuota baja en `huddle status` de quien responde
- [ ] `@auto` acierta con el destinatario
- [ ] Funciona desde dentro de Claude Code, no solo desde la terminal
- [ ] **Lo subjetivo, y lo más importante:** al dueño de la laptop B, ¿le
      molesta que le consuman cuota? Eso decide si esto sirve o no.

---

## Problemas

**Windows me pide elegir una aplicación al ejecutar `./huddle`**
Cancela el diálogo: `huddle` es un script de bash. En Windows usa
`.\huddle.cmd`.

**`curl http://IP:8787/health` no responde desde B**
La IP cambió, no están en la misma red, o el firewall de macOS bloquea a
`node`. Míralo en Ajustes → Red → Firewall → Opciones, y permite las conexiones
entrantes para `node`. Prueba primero con el firewall apagado para descartar.

**`el daemon de huddle no está corriendo`**
Te falta dejar `./huddle daemon` abierto en su propia terminal. Cada laptop
necesita el suyo.

**`token inválido`**
El `--token` de la laptop tiene que ser idéntico al `HUDDLE_TOKEN` del hub.

**`target_offline`**
El alias no está conectado. Comprueba con `./huddle who` y fíjate en que
escribiste bien el alias (con `@`).

**La respuesta dice que no encuentra nada**
El daemon expone el directorio donde estabas al hacer `join`. Si te uniste
desde el sitio equivocado, vuelve a hacer `join` desde el repositorio correcto
y reinicia el daemon.

**`quota_exceeded`**
Se acabaron las preguntas del día de esa persona. Sube el tope con
`--quota 50` y vuelve a unirte, o `--quota none` para quitarlo (solo en
pruebas).

**En Windows el daemon no arranca / error con el socket**
Debería estar resuelto: en Windows el canal de control es un named pipe
(`\\.\pipe\huddle-…`), no un archivo. Si aun así falla, pásame el error
completo — esa ruta está probada por unitarios pero no en un Windows real.

**Tarda muchísimo o se corta a los 90s**
Normal en repositorios grandes: el agente explora demasiado. Es exactamente el
problema que resuelve el pre-índice, que todavía no está hecho.

---

## Cuando termines

`Ctrl+C` en las tres terminales (hub y los dos daemons). Los datos quedan en
`~/.huddle/` de cada laptop: `config.json`, `quota.json`, `cache.json` y
`audit.jsonl` con todo lo que se preguntó y se respondió. Bórralo si quieres
empezar de cero.
