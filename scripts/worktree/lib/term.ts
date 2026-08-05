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

// SGR styling without a dependency. Worktree CI runs `bun test` against the
// bare checkout — no install — so lib/ must not import from node_modules
// (picocolors here broke that contract). Same TTY/NO_COLOR gating picocolors
// applies; stripAnsi above already erases these codes for layout tests.
const useColor = process.stdout.isTTY && process.env.NO_COLOR === undefined;
const sgr =
  (open: number, close: number) =>
  (s: string): string =>
    useColor ? `\x1b[${open}m${s}\x1b[${close}m` : s;

export const bold = sgr(1, 22);
export const dim = sgr(2, 22);
export const green = sgr(32, 39);
export const yellow = sgr(33, 39);
export const cyan = sgr(36, 39);
