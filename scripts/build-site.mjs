/**
 * Junta lo estático y lo compilado en un solo directorio que un servidor web
 * pueda servir tal cual.
 *
 * El servidor de desarrollo sirve `public/` en la raíz y `dist/` bajo `/dist`,
 * que es lo que espera el `<script src="/dist/composition/main.js">` del HTML.
 * En producción no hay servidor de desarrollo, así que esa misma forma hay que
 * dejarla escrita en disco.
 */
import { cp, rm, mkdir } from 'node:fs/promises';

const ROOT = new URL('../', import.meta.url);
const PORTAL = new URL('packages/portal/', ROOT);
const SITE = new URL('site/', ROOT);

await rm(SITE, { recursive: true, force: true });
await mkdir(SITE, { recursive: true });
await cp(new URL('public/', PORTAL), SITE, { recursive: true });
// `.tsbuildinfo` es estado del compilador, no del sitio.
await cp(new URL('dist/', PORTAL), new URL('dist/', SITE), {
  recursive: true,
  filter: (source) => !source.endsWith('.tsbuildinfo'),
});

// El HTML pide el favicon en `/brand/`, que en desarrollo sirve `dev.ts`
// desde la raíz del repositorio. Sin esto, en producción da 404.
await cp(new URL('brand/', ROOT), new URL('brand/', SITE), { recursive: true });

console.log('sitio listo en site/');
