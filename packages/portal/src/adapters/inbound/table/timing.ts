export const TIMING = {
  entrada: 420,
  radio: 520,
  arcoIda: 900,
  arcoVuelta: 760,
  destello: 900,
  salida: 260,
} as const;

export type ShouldAnimate = () => boolean;
