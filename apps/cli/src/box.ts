import { C, pad } from './style.ts';

/** The `╔═╗ ║ ╚═╝` frame `banner.ts` and `update-check.ts` draw. `width` is the inner content area; `color` is a `C` escape. */

export function boxLine(content: string, width: number, color: string, indent = ''): string {
  return `${indent}${color}║${C.reset} ${pad(content, width)} ${color}║${C.reset}`;
}

/** The title sits in the `═` fill, centred unless `left` fixes the fill to its left. */
export function boxTop(
  title: string,
  width: number,
  color: string,
  indent = '',
  left?: number,
): string {
  const inner = ` ${title} `;
  const fill = '═'.repeat(Math.max(0, width + 2 - inner.length));
  const half = left ?? Math.floor(fill.length / 2);
  return `${indent}${color}╔${'═'.repeat(half)}${C.reset}${C.bold}${inner}${C.reset}${color}${'═'.repeat(fill.length - half)}╗${C.reset}`;
}

export function boxBottom(width: number, color: string, indent = ''): string {
  return `${indent}${color}╚${'═'.repeat(width + 2)}╝${C.reset}`;
}
