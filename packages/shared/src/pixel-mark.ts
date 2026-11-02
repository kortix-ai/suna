/**
 * The Kortix symbol (`kortix-logo.tsx`, `variant="icon"`) sampled onto a
 * 12 × 10 grid. `#` is a cell the symbol fully covers; `+` is a cell on a curve
 * that it only partly covers, drawn as a checker so the curves read as dither.
 *
 * One copy for every pixel rendering of the symbol: the web `PixelKortixMark`
 * (`@kortix/ui/pixel-kortix-mark`, empty states, merch chips, My Kortix's agent
 * mark) and the TUI splash (`apps/tui/src/ui/splash.tsx`, half blocks). Rows
 * are plain text, the same width, and symmetric on both axes.
 */
export const PIXEL_KORTIX_ROWS = [
  '##   ##   ##',
  '##   ##   ##',
  '+#+  ##  +#+',
  ' ##+ ## +## ',
  '  ########  ',
  '  ########  ',
  ' ##+ ## +## ',
  '+#+  ##  +#+',
  '##   ##   ##',
  '##   ##   ##',
] as const;
