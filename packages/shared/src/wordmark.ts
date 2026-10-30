/**
 * The block-letter KORTIX wordmark the terminal surfaces print.
 *
 * One copy for the CLI landing banner (`apps/cli/src/banner.ts`) and the TUI
 * boot and empty-session splash (`apps/tui/src/ui/splash.tsx`). Brand
 * decision D31 sanctions it there, in `terminal-accent`. Rows are plain text
 * with no indent and no color: each caller adds its own.
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
