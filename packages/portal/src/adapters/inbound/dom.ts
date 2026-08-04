/**
 * Ayudas de DOM.
 *
 * El texto entra siempre por `textContent`, nunca por `innerHTML`: los alias
 * y los mensajes llegan de otra máquina.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

export interface ElementSpec {
  class?: string;
  text?: string;
  title?: string;
  attrs?: Record<string, string | number | boolean | undefined>;
  children?: Array<Node | null | undefined>;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  spec: ElementSpec = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  apply(node, spec);
  return node;
}

export function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  spec: ElementSpec = {},
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  apply(node, spec);
  return node;
}

function apply(node: Element, spec: ElementSpec): void {
  if (spec.class) node.setAttribute('class', spec.class);
  if (spec.text !== undefined) node.textContent = spec.text;
  if (spec.title !== undefined) node.setAttribute('title', spec.title);
  for (const [name, value] of Object.entries(spec.attrs ?? {})) {
    if (value === undefined || value === false) continue;
    node.setAttribute(name, value === true ? '' : String(value));
  }
  for (const child of spec.children ?? []) {
    if (child) node.appendChild(child);
  }
}

export function clear(node: Element): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function need<T extends Element>(selector: string, root: ParentNode = document): T {
  const found = root.querySelector<T>(selector);
  if (!found) throw new Error(`falta el elemento «${selector}» en el documento`);
  return found;
}

export function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}
