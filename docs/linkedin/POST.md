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

Y esperas. ⏳

Tu agente de IA conoce tu repositorio como nadie. Del suyo no sabe nada. Y la
respuesta lleva meses escrita, en un archivo, a cuarenta centímetros de la
persona que no te contesta porque está en una reunión.

Fue @oscar quien lo dijo en voz alta: «¿y si nuestras IAs tuvieran el contexto
de las demás?». Una de esas frases que suenan obvias hasta que intentas
construirlas.

Eso es Huddle: **modo multijugador para agentes de IA.**

Hasta ahora cada agente juega solo, encerrado en un repositorio. Huddle los
sienta a la misma mesa.

Haces la pregunta desde tu terminal. La responde el agente de quien mantiene
ese código, leyéndolo en ese momento, y te llega con el archivo y el commit
donde está la respuesta. Sin clonar su repo. Sin interrumpirlo a él.

Tres decisiones que lo definen:

🔒 **Tu código no viaja.** Solo la pregunta y la respuesta. El repositorio se
queda donde está, y el servidor jamás lo ve.

💳 **Ninguna API key compartida.** Cada quien responde con su propia
suscripción. Sí, eso significa que las preguntas de tus compañeros gastan tu
plan, y por eso hay tope: veinte al día por defecto, una a la vez, y las demás
hacen cola en lugar de rebotar. Tú decides cuánto prestas.

📎 **Sin fuentes no hay respuesta.** Si el agente no puede citar archivo y commit,
lo dice. Prefiero un «no lo sé» a una respuesta redonda que te manda a
producción.

🚧 Beta, open source, y ya funcionando entre macOS y Windows.

Lo que más me sorprendió construyéndolo no fue la IA. Fue contar cuántas veces
al día cortamos a alguien para preguntarle algo que estaba escrito en su
propio repositorio.

¿Cuántas van hoy? 👇

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

That's Huddle: **multiplayer for AI agents.**

Until now each agent plays alone, locked inside one repository. Huddle sits
them at the same table.

You ask from your terminal. The agent of whoever maintains that code answers,
reading it right then, and hands you the file and commit where the answer
lives.

Your code never leaves your machine. Everyone answers with their own
subscription, not a shared API key — which means your teammates' questions do
spend your plan, and that's exactly why there's a cap: twenty a day by
default. And an answer without sources isn't an answer.

Open source, in beta, already working across macOS and Windows:
github.com/Ryzeon/huddle

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

- **LinkedIn no renderiza markdown.** Los `**` de este archivo saldrían como
  asteriscos literales. Al pegar, quítalos, o usa negrita Unicode si la quieres
  de verdad (𝗮𝘀í). Los emojis y los saltos de línea sí funcionan.
- **Etiqueta a Oscar de verdad.** Aparece en la primera línea, que es lo que se
  lee sin desplegar, y vuelve al final. Un post con alguien etiquetado circula
  bastante más que un monólogo.
- **El enlace, en el post.** LinkedIn penaliza menos de lo que se cree y
  ponerlo en comentarios hace que mucha gente no lo encuentre.
- **La primera línea decide.** Todo lo demás va colapsado tras el «ver más», así
  que si esa frase no engancha, el resto da igual.
- **No prometas de más.** Está en beta, hay un solo motor de IA y no hay
  autenticación. Si alguien pregunta, dilo: el README lo dice también.
