# Huddle — identidad visual

Guía corta y operativa. Todo lo que hay en `brand/` es SVG vectorial escrito a
mano: sin imágenes embebidas, sin base64, sin fuentes externas.

---

## 1. De dónde sale el símbolo

Huddle no es un chat ni un asistente. Es **un corrillo**: dos personas (o
más) que se juntan un momento alrededor de una pregunta concreta, cada una
trayendo su propio contexto, y se separan. Todo ocurre en la terminal.

Se exploraron tres direcciones.

### A · El corrillo de prompts — **elegida**

El `>` del prompt es el símbolo que un usuario de Huddle ya teclea cien veces
al día. Si cada participante *es* un prompt, un huddle son prompts mirando al
mismo punto. Ese punto es la sala: una celda de terminal, el cursor.

```
> ▮ <
```

Se lee como algo tecleable, no como un logotipo de agencia. La celda del
centro no es decoración: es la pregunta compartida, lo único que los dos
participantes tienen en común (cada uno sigue en su repo, a su lado).

### B · El código de sala

Monograma construido con la retícula del código de acceso (`MPP8V-7HZS5`):
dos bloques de celdas unidos por un guion. **Descartada:** depende de leer
caracteres, así que muere a 16 px, y ata la marca a un formato de código que
puede cambiar.

### C · El fork de contexto

Una línea que se bifurca en N ramas, una por repo — el `--fork-session` hecho
dibujo. **Descartada:** es indistinguible de la iconografía de ramas de git, y
describe la implementación en lugar de la experiencia.

### Nota honesta sobre el proceso

La dirección A se dibujó primero como **tres chevrons en anillo**, rotados
120° alrededor de un centro vacío. Renderizada, falló: a tamaño grande se leía
como tres piezas sueltas (dos de ellas en diagonal, sin orientación canónica)
y a 16 px era una mancha. Se rehízo con **simetría bilateral** — dos chevrons
enfrentados y la celda en medio — y ahí sí aguanta las tres pruebas: 16 px,
monocromo y escala grande. Vale la pena recordarlo: la idea era correcta, la
primera composición no.

---

## 2. Construcción

El símbolo vive en una caja de `120 × 120`. La geometría es la misma en todos
los archivos; solo cambian el color y la escala.

- **Chevrons:** polígonos de siete vértices, no trazos con `stroke`. El grosor
  perpendicular es constante (15 unidades). Los remates son **cortes
  verticales** y la punta está **truncada en plano** — nada de miter infinito
  ni esquinas redondeadas. Ese corte recto es lo que le da el aire de píxel.
- **Celda:** cuadrado de `22 × 22` centrado. Es el único elemento a color.
- **Aire interior:** 7 unidades entre cada punta y la celda. Es el margen que
  sostiene la lectura a 16 px; no lo reduzcas.

El logotipo es **monolínea**: trazo constante de 12,5 unidades, altura de x de
44, ascendentes de 72, sin remates ni contraste de grosor. Está dibujado como
paths con `stroke`, así que escala sin degradarse y hereda color por herencia
CSS si lo incrustas.

| Pieza | viewBox | Proporción |
|---|---|---|
| `logo.svg` / `logo-dark.svg` | `0 0 416 120` | 3,47 : 1 |
| `isotipo.svg` / `isotipo-dark.svg` | `0 0 128 128` | 1 : 1 |
| `favicon.svg` | `0 0 32 32` | 1 : 1 |

---

## 3. Paleta

Fósforo ámbar sobre carbón, papel cálido para el modo claro. Nada de morados,
nada de degradados.

### Núcleo

| Nombre | Hex | Para qué sirve |
|---|---|---|
| **Tinta** | `#14110F` | Texto y marca sobre fondo claro. Casi negro, pero cálido: 17,5:1 sobre papel. |
| **Papel** | `#FAF6F0` | Fondo claro. Blanco roto, con temperatura; el blanco puro deja la marca fría. |
| **Carbón** | `#191512` | Fondo oscuro. El de una terminal bien configurada, no negro absoluto. |
| **Ámbar** | `#FFB000` | Acento sobre oscuro. Es el fósforo ámbar de los CRT. La celda del símbolo, el cursor, el foco. 9,9:1 sobre carbón. |
| **Brasa** | `#C2610A` | El mismo acento traducido a fondo claro. El ámbar puro no aguanta el papel (1,7:1); esta versión da 3,9:1, suficiente para forma, no para texto. |

### Texto secundario

| Nombre | Hex | Para qué sirve |
|---|---|---|
| **Humo** | `#6F6763` | Texto secundario sobre claro (5,1:1). Metadatos, rutas, timestamps. |
| **Ceniza** | `#A39A94` | El equivalente sobre oscuro (6,6:1). |
| **Óxido** | `#9A4D08` | Cuando el acento tiene que ser *texto* sobre claro (5,7:1). Enlaces, alias resaltado. |

### Estado

| Nombre | Hex (oscuro) | Hex (claro) | Para qué sirve |
|---|---|---|---|
| **Señal** | `#3FB950` | `#1A7F37` | En sala, respondiendo, acierto de caché. |
| **Alerta** | `#D9453C` | `#B3271E` | Cuota agotada, `rate_limit`, timeout, miembro bloqueado. |

**Regla de acento:** en cualquier composición hay **un solo** ámbar/brasa. Es
el cursor: si hay dos, ya no señala nada.

---

## 4. Tipografía

Todo lo recomendado es libre y se puede empaquetar con el proyecto.

| Uso | Fuente | Licencia |
|---|---|---|
| Interfaz, código, titulares, CLI | **JetBrains Mono** | Apache 2.0 |
| Alternativa mono (más neutra) | **IBM Plex Mono** | OFL 1.1 |
| Texto largo (docs, web) | **Inter** o **IBM Plex Sans** | OFL 1.1 |

- Titulares en JetBrains Mono **Bold**, en minúsculas, con tracking ligeramente
  abierto (`0.02em`). Huddle se escribe **siempre en minúsculas**, incluso a
  principio de frase.
- Alias siempre con `@` y en mono: `@oscagod`, `@oscagod:api`, `@auto`, `@all`.
- Códigos de sala en mono, mayúsculas, con el guion tal cual: `MPP8V-7HZS5`.
  No los partas de línea.
- El logotipo **no** está compuesto con ninguna de estas fuentes: son formas
  dibujadas a medida. No intentes recomponerlo tecleando "huddle" en mono.
- Los SVG no cargan ninguna tipografía. Si necesitas texto dentro de un SVG
  para otra pieza, usa `font-family="ui-monospace, monospace"`.

---

## 5. Espaciado mínimo

La unidad es **X = el lado de la celda central** del símbolo (en `logo.svg`,
17,16 unidades del viewBox; ≈ 14 % de la altura del logo).

- **Área de respeto:** 1X libre por los cuatro lados, **medido desde el borde
  del viewBox del archivo** (que ya trae algo de aire propio). Recomendado 1,5X.
  A 300 px de ancho eso son 12,4 px; a 400 px, 16,5 px.
- Dentro de esa zona no entra nada: ni texto, ni bordes, ni otro logo, ni el
  borde del lienzo.
- **Separación símbolo ↔ palabra:** fija, ya está en el archivo. No la toques.

---

## 6. Tamaños mínimos

| Pieza | Mínimo | Comprobado |
|---|---|---|
| Logo horizontal | **120 px de ancho** | legible a 120 px; por debajo usa el isotipo |
| Isotipo | **16 px** | sí, con la celda visible |
| Favicon | **16 px** | sí |

Por debajo de 120 px de ancho, el logotipo pierde el contra de la `e` y las
`dd` se cierran. Ahí cambia al isotipo: no hay versión intermedia.

---

## 7. Monocromo

El símbolo está diseñado para funcionar en un solo color: la celda pasa a
tinta (o a papel sobre fondo oscuro) y sigue leyéndose, porque el aire de 7
unidades la mantiene separada de las puntas. Comprobado en render a 16 y 64 px.

Usos válidos en un color: grabado, serigrafía a una tinta, `README` en blanco y
negro, sellos, watermark. Para watermark, tinta al 12 % de opacidad.

---

## 8. Usos correctos

- Logo completo en cabeceras, README, web y presentaciones.
- Isotipo para avatar (GitHub, npm, Slack), favicon y app icon.
- Sobre fondo plano: papel, carbón, o un color de la paleta con contraste
  suficiente.
- En una sola tinta cuando el medio lo pida.
- El símbolo puede usarse como bullet o separador en documentación de Huddle,
  a tamaño de línea de texto.

## 9. Usos incorrectos

- **No** rotes, inclines ni reflejes el símbolo. Su simetría es horizontal;
  girado deja de leerse como dos prompts.
- **No** cambies la proporción entre símbolo y palabra, ni los separes con más
  espacio del que trae el archivo.
- **No** pongas el ámbar `#FFB000` sobre papel, ni la brasa `#C2610A` sobre
  carbón como texto: no llegan al contraste.
- **No** añadas un segundo acento de color. Una composición, un cursor.
- **No** le pongas sombra, brillo, degradado, bisel ni glow de CRT. La
  referencia retro está en las formas y en el color, no en los efectos.
- **No** metas el logo dentro de una burbuja de chat, un bocadillo ni un
  círculo con borde.
- **No** rellenes la celda central con otro color por estado. Los estados van
  en la interfaz, no en la marca.
- **No** escribas "Huddle" con mayúscula inicial en el logotipo, ni recompongas
  la palabra con una fuente.
- **No** uses el logo sobre una fotografía o un fondo con textura sin una capa
  plana debajo.

---

## 10. Archivos

```
brand/
  logo.svg           marca completa, fondo claro
  logo-dark.svg      marca completa, fondo oscuro
  isotipo.svg        símbolo cuadrado con fondo papel (avatar)
  isotipo-dark.svg   símbolo cuadrado con fondo carbón
  favicon.svg        versión de 32 unidades, probada a 16 px
  marca.md           este documento
  preview.html       todas las variantes sobre claro y oscuro
  preview/           renders PNG a 16, 32, 64 y 512 px
```

Los isotipos traen fondo propio porque su destino es el avatar y el favicon,
donde el recorte es cuadrado. Si necesitas el símbolo suelto sobre
transparente, borra el `<rect>` de fondo del archivo: el resto es el símbolo.
