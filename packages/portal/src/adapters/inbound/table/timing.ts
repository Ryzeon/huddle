/**
 * Duraciones de la mesa, en un solo sitio para poder afinarlas de una pasada.
 */

export const TIMING = {
  entrada: 420,
  radio: 520,
  arcoIda: 900,
  arcoVuelta: 760,
  destello: 900,
  salida: 260,
} as const;

/**
 * Si toca animar o no.
 *
 * Las capas no consultan el sistema por su cuenta: reciben esta función. Así
 * `?estatico=1` puede forzar el modo sin animación para que las capturas sean
 * deterministas, y los tests podrían pasar una constante.
 */
export type ShouldAnimate = () => boolean;
