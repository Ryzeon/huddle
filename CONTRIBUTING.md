# Contribuir

Gracias por mirar. Esto es lo que hace falta saber para no perder tiempo.

## Levantarlo

```bash
npm install
npm test          # sin sockets ni subprocesos: tarda un segundo
npm run build
```

Para verlo funcionar de verdad hacen falta tres cosas en tres terminales:

```bash
npm run hub                                    # 1. el hub
huddle create "Pruebas" @yo --hub ws://localhost:8787   # 2. una sala
npm run portal                                 # 3. el portal, en :5173
```

El portal solo, sin nada más: `http://127.0.0.1:5173/?demo=1`. Es un guion
grabado, sin hub ni agentes, y sirve para trabajar en la interfaz.

## Cómo está montado

Cuatro paquetes: `protocol` (el contrato y su validación), `hub` (salas, ruteo,
historial, la carpeta de la sala), `agent` (responder y preguntar) y `portal`
(la sala dibujada).

Dentro de cada uno, puertos y adaptadores con las dependencias hacia el centro:

```
domain/        reglas puras, sin I/O
application/   casos de uso; solo conocen puertos
adapters/      todo lo que toca el mundo: sockets, disco, procesos
composition/   el único sitio donde se instancia infraestructura
```

**La regla que lo sostiene:** `domain/` y `application/` no importan `ws`,
`node:net`, `node:fs` ni `node:child_process`. Si eso deja de cumplirse, se ha
filtrado una capa. Es lo que permite probar un timeout, una desconexión a mitad
de respuesta o una rotación de código sin levantar un servidor.

Si te encuentras haciendo un mock complicado, casi siempre es que la lógica está
en la capa equivocada, no que falte una librería de mocks.

## Estilo

- **Los comentarios explican por qué, no qué.** Un comentario que repite la
  línea de al lado sobra; uno que dice por qué no se hizo de la forma obvia vale
  su peso en oro. Mira cualquier archivo del repositorio: ese es el listón.
- **En español**, código y comentarios, como el resto.
- **Los mensajes de commit llevan solo la línea de asunto**, en formato
  conventional commits (`fix(hub): …`). Si un commit necesita párrafos de
  explicación, suele ser señal de que hay que partirlo en dos.
- **Un test que falla antes de tu arreglo** vale más que tres que pasan después.

## Al mandar un PR

Lo que pide la plantilla, y poco más: qué cambia, por qué, y cómo lo probaste.
Si tocaste el hub, el agente o el portal, cuenta qué probaste **a mano** — los
tests no abren sockets, así que hay fallos que solo aparecen con dos daemons
hablando de verdad. Windows también cuenta: los sockets de control y las rutas
se comportan distinto ahí.

## Seguridad

Un fallo de seguridad no va en un issue público. Huddle deja que alguien dispare
lectura en el directorio de trabajo de otra persona, así que un agujero se
cuenta primero en privado:
[abrir un aviso](https://github.com/Ryzeon/huddle/security/advisories/new).

Y en cualquier cosa que pegues —issue, PR, captura—: **el código de sala es la
llave**. Táchalo. Si se te escapa, `huddle rotate` da uno nuevo sin perder la
sala.
