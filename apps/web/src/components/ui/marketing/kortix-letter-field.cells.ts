export const SOURCE = '01kortixcomputer';
export const PROPER = SOURCE.split('').join(' ');
export const KORTIX = 'kortix'.split('').join(' ');

export type TokenKind = 'scrambled' | 'proper' | 'kortix';

export interface Token {
  text: string;
  kind: TokenKind;
}

export function createRng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffleWithSpaces(chars: string, rng: () => number) {
  const arr = chars.split('');
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.join(' ');
}

export function buildTokens(count: number, seed: number): Token[] {
  const rng = createRng(seed);
  return Array.from({ length: count }, () => {
    const roll = rng();
    if (roll < 0.06) return { text: KORTIX, kind: 'kortix' as const };
    if (roll < 0.14) return { text: PROPER, kind: 'proper' as const };
    return { text: shuffleWithSpaces(SOURCE, rng), kind: 'scrambled' as const };
  });
}

export interface GridLayout {
  cols: number;
  rows: number;
  tokenCount: number;
  cellWidth: number;
  cellHeight: number;
  padding: number;
  fontSize: number;
}

// Per-cell geometry — mirrors the original HTML grid
// (`repeat(cols, minmax(0, 1fr))` with the same min cell width so "k o r t i x"
// never clips).
export const CELL_HEIGHT_PX = 14;
export const CELL_HEIGHT_PX_SM = 12;
export const GAP_X = 4;
export const GAP_Y = 2;
export const PADDING = 24;
export const PADDING_SM = 16;
export const MIN_CELL_WIDTH_PX_SM = 76;
export const MIN_CELL_WIDTH_PX_MD = 84;
export const MIN_CELL_WIDTH_PX_LG = 92;

export function computeGrid(width: number, height: number): GridLayout {
  const isSm = width < 640;
  const isLg = width >= 1024;
  const cellHeight = isSm ? CELL_HEIGHT_PX_SM : CELL_HEIGHT_PX;
  const padding = isSm ? PADDING_SM : PADDING;
  const minCellWidth = isSm
    ? MIN_CELL_WIDTH_PX_SM
    : isLg
      ? MIN_CELL_WIDTH_PX_LG
      : MIN_CELL_WIDTH_PX_MD;
  const fontSize = isSm ? 8 : isLg ? 10 : 9;

  const innerWidth = Math.max(0, width - padding * 2);
  const innerHeight = Math.max(0, height - padding * 2);

  const cols = Math.max(1, Math.floor((innerWidth + GAP_X) / (minCellWidth + GAP_X)));
  const rows = Math.max(1, Math.ceil((innerHeight + GAP_Y) / (cellHeight + GAP_Y)));

  // Distribute the inner width evenly across columns so the visual matches the
  // old `1fr` grid (each cell grows to fill, tokens left-aligned inside).
  const cellWidth = (innerWidth - GAP_X * (cols - 1)) / cols;

  return { cols, rows, tokenCount: cols * rows, cellWidth, cellHeight, padding, fontSize };
}

// Per-token fill opacity, matching the original Tailwind opacity classes
// (`text-foreground/90`, `/35`, `/20`, dark `/14`). Dark mode uses darker
// opacities; the active set is picked from `isDark` (resolved live from the
// container's computed `color` so it tracks any theme).
export const OPACITY_BY_KIND: Record<TokenKind, { light: number; dark: number }> = {
  kortix: { light: 0.9, dark: 0.5 },
  proper: { light: 0.35, dark: 0.35 },
  scrambled: { light: 0.2, dark: 0.14 },
};

// XML-escape a string for safe embedding inside an SVG data URI.
export function svgEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Build an inline SVG document string for the whole letter field, rendered as a
// CSS `background-image: url("data:image/svg+xml,…")` so the decorative letter
// tokens are pure image content — they do NOT appear as text anywhere in the DOM
// (not even in `innerText`, which is what Google's renderer can extract for
// SERP snippets). This is the airtight fix for the garbled brand-snippet
// regression: the old `<span>` grid (and even an inline `<svg><text>` grid)
// leaked the scrambled `t p e x 1 o c i0…` tokens into the page's text content,
// which Google surfaced for the `dosco` brand query instead of the meta
// description. A CSS background image has zero text content.
export function buildFieldSvg(
  tokens: Token[],
  grid: GridLayout,
  color: string,
  isDark: boolean,
): string {
  const { cols, cellWidth, cellHeight, padding, fontSize } = grid;
  const innerWidth = cols * cellWidth + (cols - 1) * GAP_X;
  const rows = Math.ceil(tokens.length / cols);
  const innerHeight = rows * cellHeight + (rows - 1) * GAP_Y;
  const vbWidth = innerWidth + padding * 2;
  const vbHeight = innerHeight + padding * 2;
  const baseline = padding + cellHeight - 2;

  const monoStack = 'var(--font-mono), ui-monospace, SFMono-Regular, Menlo, monospace';

  const textNodes = tokens
    .map((token, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = padding + col * (cellWidth + GAP_X);
      const y = padding + row * (cellHeight + GAP_Y) + (baseline - padding);
      const opacity = OPACITY_BY_KIND[token.kind][isDark ? 'dark' : 'light'];
      const weight = token.kind === 'kortix' ? 600 : 500;
      return `  <text x="${x}" y="${y}" font-family="${svgEscape(monoStack)}" font-size="${fontSize}" font-weight="${weight}" letter-spacing="${0.12 * fontSize}" fill="${svgEscape(color)}" fill-opacity="${opacity}">${svgEscape(token.text)}</text>`;
    })
    .join('\n');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${vbWidth}" height="${vbHeight}" viewBox="0 0 ${vbWidth} ${vbHeight}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="dosco"><title>dosco</title>\n${textNodes}\n</svg>`;
}

// URL-encode an SVG string for a `data:image/svg+xml,...` background URL.
// `#`, `%`, `<`, `>`, `"`, and newlines must be encoded so the URI is valid in
// CSS and survives any intermediate normalization.
export function svgToDataUri(svg: string): string {
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
