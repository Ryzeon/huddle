<!--
  Si el cambio es de una línea y se explica solo, borra lo que no aplique y
  déjalo en dos frases. Esto es una ayuda, no un peaje.
-->

## Qué cambia

<!-- En una o dos frases, y desde fuera: qué se puede hacer ahora que antes no. -->

## Por qué

<!--
  El problema que había. Si el porqué es sutil o la solución obvia no valía,
  cuéntalo aquí y también en un comentario del código: dentro de seis meses,
  quien lo lea no tendrá este PR delante.
-->

## Cómo lo has probado

<!--
  `npm test` es el suelo, no el techo. Si tocaste el hub, el agente o el portal,
  di qué probaste a mano: dos daemons contra un hub, el portal en el navegador,
  Windows, lo que sea.
-->

---

- [ ] `npm test` en verde
- [ ] `npm run build` sin errores
- [ ] `domain/` y `application/` siguen sin importar `ws`, `node:net`, `node:fs`
      ni `node:child_process` — si eso deja de cumplirse, se ha filtrado una capa
- [ ] Los comentarios nuevos explican **por qué**, no qué hace la línea de al lado
- [ ] Nada de secretos, tokens ni códigos de sala en el diff
