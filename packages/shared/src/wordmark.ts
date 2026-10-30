/**
 * The block-letter KORTIX wordmark the terminal surfaces print.
 *
 * The CLI landing banner (`apps/cli/src/banner.ts`) prints it, in
 * `terminal-accent` (brand decision D31). The TUI draws the pixel symbol
 * instead (`@kortix/shared/pixel-mark`, D32). Rows are plain text with no
 * indent and no color: each caller adds its own.
 */
export const KORTIX_WORDMARK: readonly string[] = [
  '██╗  ██╗ ██████╗ ██████╗ ████████╗██╗██╗  ██╗',
  '██║ ██╔╝██╔═══██╗██╔══██╗╚══██╔══╝██║╚██╗██╔╝',
  '█████╔╝ ██║   ██║██████╔╝   ██║   ██║ ╚███╔╝ ',
  '██╔═██╗ ██║   ██║██╔══██╗   ██║   ██║ ██╔██╗ ',
  '██║  ██╗╚██████╔╝██║  ██║   ██║   ██║██╔╝ ██╗',
  '╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═╝   ╚═╝   ╚═╝╚═╝  ╚═╝',
];

/** Display columns of the widest row. Every glyph above is one column wide. */
export const KORTIX_WORDMARK_WIDTH = Math.max(...KORTIX_WORDMARK.map((row) => row.length));
