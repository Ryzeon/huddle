# Post de LinkedIn

Imágenes en esta carpeta, en orden de uso:

| Archivo | Qué es | De dónde sale |
|---|---|---|
| `01-portal.png` | el portal en tema oscuro, con una pregunta en vuelo | captura real, 2880×1800 |
| `02-consola.svg` | una respuesta en la terminal, con fuentes y commit | ejemplo con un repo ficticio |
| `03-portal-claro.png` | el mismo portal en tema claro | captura real |

Para LinkedIn, `01-portal.png` como imagen principal. Si vas a carrusel, ese
primero y la consola segunda: se entiende mejor el producto viendo la sala
antes que el comando.

El SVG lo abres en el navegador y le haces captura, o lo conviertes a PNG. Si
prefieres una consola tuya de verdad, corre esto y captura la pantalla:

```bash
huddle ask @alguien "de qué trata este repositorio?"
```

---

## Post

«¿Sabes si el campo status puede venir null?»

Lo preguntas por el chat del equipo. Estás integrando el API de otro squad para
sacar una feature. La documentación tiene tres meses y el Swagger miente en dos
campos.

Y esperas.

Tu agente de IA conoce tu repositorio al dedillo. Del suyo no sabe nada. Y la
respuesta lleva meses escrita, en un archivo, a cuarenta centímetros de la
persona que no te contesta porque está en una reunión.

Fue @oscar quien lo dijo en voz alta: «¿y si nuestras IAs tuvieran el contexto
de las demás?». Una de esas frases que suenan obvias hasta que intentas
construirlas.

Eso es Huddle.

Una sala donde el agente de IA de cada persona responde sobre **su**
repositorio. Preguntas y contesta el agente de quien mantiene ese código, con
su contexto, citando el archivo y el commit exactos. Sin clonar nada. Sin
interrumpir a nadie.

Tres decisiones que lo definen:

**Tu código no viaja.** Solo la pregunta y la respuesta. El repositorio se
queda donde está, y el servidor jamás lo ve.

**Nadie paga por todos.** Cada quien responde con su propia suscripción, así
que nadie puede gastarte el plan: veinte preguntas al día por defecto, y las
que llegan a la vez hacen cola en lugar de rebotar.

**Sin fuentes no hay respuesta.** Si el agente no puede citar archivo y commit,
lo dice. Prefiero un «no lo sé» a una respuesta redonda que te manda a
producción.

Beta, open source, funcionando hoy en macOS, Linux y Windows.

Lo que más me sorprendió construyéndolo no fue la IA. Fue contar cuántas veces
al día interrumpimos a alguien para preguntarle algo que su repositorio ya
sabía responder.

¿Cuántas van hoy?

🔗 github.com/Ryzeon/huddle

#OpenSource #DeveloperTools #IA #Backend

## Primer comentario, en inglés

"Do you know if the status field can come back null?"

You ask it in the team chat. You're integrating another squad's API to ship a
feature.
The docs are three months old and the Swagger lies about two fields.

And you wait.

Your AI agent knows your repo inside out. It knows nothing about theirs. And
the answer has been sitting in a file for months, forty centimeters away from
the person who can't reply because they're in a meeting.

That's Huddle: a room where each person's AI agent answers about *their*
repository, citing exact files and commits.

Your code never leaves your machine. It runs on each person's own
subscription, not a shared API key. And an answer without sources isn't an
answer.

Open source, in beta, working today: github.com/Ryzeon/huddle

## Segundo comentario, para quien pregunte por el stack

TypeScript de punta a punta. Un daemon en cada máquina que sostiene la sesión
de Claude Code y ejecuta sobre el repositorio; un hub que solo interconecta por
WebSocket, rutea y guarda el historial. El daemon escucha, ejecuta y responde;
el hub nunca ve el código.

Una sola dependencia de producción: `ws`. Arquitectura hexagonal en los cuatro
paquetes, así que los tests corren en medio segundo sin abrir un socket. El
frontend no tiene framework ni bundler.

---

## Notas

- **Etiqueta a Oscar de verdad.** Aparece en la primera línea, que es lo que se
  lee sin desplegar, y vuelve al final. Un post con alguien etiquetado circula
  bastante más que un monólogo.
- **El enlace, en el post.** LinkedIn penaliza menos de lo que se cree y
  ponerlo en comentarios hace que mucha gente no lo encuentre.
- **La primera línea decide.** Todo lo demás va colapsado tras el «ver más», así
  que si esa frase no engancha, el resto da igual.
- **No prometas de más.** Está en beta, hay un solo motor de IA y no hay
  autenticación. Si alguien pregunta, dilo: el README lo dice también.
