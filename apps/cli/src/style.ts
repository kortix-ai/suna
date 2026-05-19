/**
 * Central styling primitives — color palette + glyph helpers lifted
 * from the legacy Kortix installer (`scripts/get-kortix.sh`, the
 * `~/.kortix/kortix` script). Use these everywhere so the new CLI
 * matches the look the existing CLI already established.
 */

const ENABLED = process.stdout.isTTY === true && !process.env.NO_COLOR;

function code(seq: string): string {
  return ENABLED ? seq : '';
}

export const C = {
  reset: code('\x1b[0m'),
  bold: code('\x1b[1m'),
  dim: code('\x1b[2m'),
  green: code('\x1b[0;32m'),
  red: code('\x1b[0;31m'),
  cyan: code('\x1b[0;36m'),
  yellow: code('\x1b[1;33m'),
  white: code('\x1b[1;37m'),
  faded: code('\x1b[2;37m'),
} as const;

/** Strip ANSI escape codes from a string. */
export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

/** Visible character width, ignoring ANSI codes. */
export function visibleWidth(s: string): number {
  return stripAnsi(s).length;
}

/** Right-pad a colored string to `width` visible columns. */
export function pad(s: string, width: number): string {
  const extra = Math.max(0, width - visibleWidth(s));
  return s + ' '.repeat(extra);
}

/** Installer-style status helpers. */
export const status = {
  info: (msg: string) => `  ${C.cyan}▸${C.reset}  ${msg}`,
  ok: (msg: string) => `  ${C.green}✓${C.reset}  ${msg}`,
  warn: (msg: string) => `  ${C.yellow}!${C.reset}  ${C.yellow}${msg}${C.reset}`,
  err: (msg: string) => `  ${C.red}✗${C.reset}  ${C.red}${msg}${C.reset}`,
} as const;

/** Faded horizontal rule, full installer width. */
export function rule(width = 56): string {
  return `  ${C.faded}${'─'.repeat(width)}${C.reset}`;
}

/** "  Kortix CLI  v0.1.0" header style. */
export function header(title: string, version: string): string {
  return `  ${C.white}${C.bold}${title}${C.reset}  ${C.faded}v${version}${C.reset}`;
}
