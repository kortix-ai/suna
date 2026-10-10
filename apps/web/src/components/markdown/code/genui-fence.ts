// The one apps/web import of `@kortix/sdk/genui/fence`: fence detection only, it never loads
// `@openuidev/*` or `zod`. Listed in CANONICAL_SDK_ENTRIES (`scripts/sdk-boundary.mjs`).
// eslint-disable-next-line no-restricted-imports -- light fence helpers for the main markdown chunk
import { genuiVersionFromClassName, splitGenui } from '@kortix/sdk/genui/fence';

export { genuiVersionFromClassName };

/**
 * The generative UI fence still open at the end of `text`: its body so far and the line that
 * closes it (same marker as the opener), or null. Only the last block of a reply can be open.
 * Open means the model is still writing it, or the reply was cut off inside it.
 */
export function openGenuiFence(text: string): { code: string; closer: string } | null {
  if (!/openui/i.test(text)) return null;
  const last = splitGenui(text).at(-1);
  if (last?.kind !== 'genui' || last.closed) return null;
  // The body is everything after the opener line, so the opener is the last line before it.
  const opener = text.slice(0, text.length - last.code.length).replace(/\n$/, '').split('\n').pop() ?? '';
  return { code: last.code, closer: `\n${/`{3,}|~{3,}/.exec(opener)?.[0] ?? '```'}` };
}
