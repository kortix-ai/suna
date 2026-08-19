/**
 * Terminal rendering primitives.
 *
 * The colour table used to be copy-pasted into agent.ts and cli.ts, which drifted
 * (one carried keys the other did not). One table, one place.
 */
export const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  white: '\x1b[97m',
  gray: '\x1b[90m',
} as const;

const ANSI = /\x1b\[[0-9;]*m/g;

export function stripAnsi(value: string): string {
  return value.replace(ANSI, '');
}

/** Printable width, ignoring colour escapes. Needed to pad boxed layouts. */
export function visibleLength(value: string): number {
  return stripAnsi(value).length;
}

export function clearScreen(): void {
  process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Status glyphs. Kept together so "on/off/warn" reads the same everywhere. */
export const glyph = {
  on: `${c.green}●${c.reset}`,
  off: `${c.gray}○${c.reset}`,
  warn: `${c.yellow}!${c.reset}`,
  bad: `${c.red}✗${c.reset}`,
  mark: `${c.cyan}◆${c.reset}`,
} as const;

/** `  label      value` — the two-column layout shared by status and summaries. */
export function field(label: string, value: string, width = 14): void {
  console.log(`  ${c.dim}${label.padEnd(width)}${c.reset}${value}`);
}

export function blankLine(): void {
  console.log('');
}
