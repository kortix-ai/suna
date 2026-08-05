/**
 * Terminal text primitives shared by the renderers.
 *
 * Colour and hyperlink escapes are zero-width: they must never be counted when
 * padding a column, and `stripAnsi` is what lets a test assert a layout without
 * caring whether the runner had a TTY.
 */

// OSC 8 hyperlink — makes `text` actually clickable in supporting terminals
// (iTerm2, VS Code, modern macOS terminals). Terminals without OSC 8 support
// just render `text` as-is, so styling is left to the caller for graceful
// degradation. Wrap only the visible glyphs (no trailing padding) so the
// clickable/underlined region matches the text exactly.
export const link = (href: string, text: string) =>
  process.stdout.isTTY ? `\x1b]8;;${href}\x07${text}\x1b]8;;\x07` : text;

const SGR = /\x1b\[[0-9;]*m/g;
const OSC8 = /\x1b\]8;;[^\x07\x1b]*(?:\x07|\x1b\\)/g;

/** Visible text with every SGR colour and OSC 8 hyperlink escape removed. */
export function stripAnsi(s: string): string {
  return s.replace(OSC8, '').replace(SGR, '');
}

/** Column count of `s` once escapes are discarded. */
export function visibleWidth(s: string): number {
  return stripAnsi(s).length;
}
