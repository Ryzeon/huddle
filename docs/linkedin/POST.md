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

«¿Y si nuestras IAs tuvieran el contexto de las demás?»

Me lo dijo Oscar, un compañero, entre dos reuniones. Una de esas frases que
suenan obvias hasta que intentas construirlas.

Yo llevaba dos días esperando que alguien me contestara una pregunta de tres
líneas sobre su código. No era culpa suya: estaba ocupado, luego dormido, y el
contexto que yo necesitaba solo existía en su máquina.

Esa frase suya y esos dos días míos son Huddle.

Es una sala donde el agente de IA de cada persona responde sobre **su**
repositorio. Preguntas «¿en qué puerto corre el servicio de facturación?» y
contesta el agente de quien lo mantiene, con su contexto, citando el archivo y
el commit exactos.

Tres decisiones que lo definen:

**Tu código nunca sale de tu máquina.** Solo viaja la pregunta y la respuesta.
El servidor no ve el repositorio, nunca.

**Usa la suscripción de cada quien, no una API key compartida.** Cada persona
responde con su propia cuenta. Eso trae un límite honesto: veinte preguntas al
día, y las simultáneas hacen cola en vez de rebotar.

**Una respuesta sin fuentes no cuenta como respuesta.** Si no puede citar
archivos, el agente lo dice en vez de inventar.

Está en beta, es open source y funciona hoy entre macOS, Linux y Windows.

Lo que más me sorprendió construyéndolo no fue la IA. Fue descubrir cuántas
veces al día le preguntamos a alguien algo que su repositorio ya sabía
responder.

La idea es suya. Gracias @oscar 🙌

🔗 github.com/Ryzeon/huddle

#OpenSource #DeveloperTools #IA #Backend

## Primer comentario, en inglés

"What if our AIs had each other's context?"

My teammate Oscar said that between two meetings. One of those lines that
sound obvious until you try to build them. Meanwhile I had spent
two days waiting for someone to answer a three-line question about his own
code. Not his fault: he was busy, then asleep, and the context I needed only
lived on his machine.

His sentence and my two days are Huddle. A room where each person's AI agent answers about *their*
repository, citing exact files and commits.

Your code never leaves your machine. It runs on each person's own
subscription, not a shared API key. And an answer without sources isn't an
answer.

Open source, in beta, working today: github.com/Ryzeon/huddle

---

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
