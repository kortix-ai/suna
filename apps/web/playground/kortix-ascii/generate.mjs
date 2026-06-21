// Kortix SVG → ASCII art generator — a self-contained play-around.
//
// UNFINISHED EXPERIMENT, not wired to anything. It rasterizes the official
// Kortix brand SVGs (the radial 6-blade symbol and the full "Kortix" logomark)
// into terminal ASCII art — the same idea as the game-of-life landing canvas
// (apps/web/src/app/game-of-life), which loads the real brandmark, samples
// pixel coverage, and stamps it into a grid. Here we emit characters instead of
// canvas cells. See README.md in this folder.
//
// Pure Node, no deps: the brand paths only use absolute M/H/V/C/Z, so we
// flatten the cubic béziers to polylines and fill with an even-odd scanline
// (which gives us the letter holes in o / R / i for free).
//
// IMPORTANT — never hand-type the output. Box-drawing art is corrupted by
// next-token prediction. This script is the ONLY thing that should write these
// glyphs. Read the catalog (ascii-logo.md); copy art, never retype it.
//
// Outputs (with --write), written next to this file:
//   ascii-logo.md            human-readable catalog of every variation
//   ascii-logo.generated.ts  exact string constants (importable)
//
// Usage (from apps/web/):
//   node playground/kortix-ascii/generate.mjs            # print catalog to stdout
//   node playground/kortix-ascii/generate.mjs --write    # (re)generate both files
//
// Re-run after any brand refresh. Source of truth = apps/web/public/brandkit.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(__dirname, '../..'); // apps/web

const SYMBOL_SVG = resolve(WEB, 'public/brandkit/Logo/Brandmark/SVG/Brandmark Black.svg');
const LOGOMARK_SVG = resolve(WEB, 'public/brandkit/Logo/Logomark/SVG/Logomark Black.svg');
const WORDMARK_TXT = resolve(__dirname, 'kortix-wordmark.txt'); // canonical KORTIX block letters

// ── SVG path parsing ────────────────────────────────────────────────────────

/** Extract the viewBox + every `d="…"` from an SVG file. */
function readSvg(file) {
  const raw = readFileSync(file, 'utf8');
  const vb = raw.match(/viewBox="([^"]+)"/);
  const [, , w, h] = vb ? vb[1].split(/[\s,]+/).map(Number) : [0, 0, 0, 0];
  const ds = [...raw.matchAll(/\sd="([^"]+)"/g)].map((m) => m[1]);
  return { width: w, height: h, ds };
}

/** Tokenize a path's numbers/commands. Brand paths are all absolute. */
function tokenize(d) {
  const out = [];
  const re = /([MLHVCZ])|(-?\d*\.?\d+(?:e-?\d+)?)/gi;
  let m;
  while ((m = re.exec(d))) out.push(m[1] ? m[1].toUpperCase() : Number(m[2]));
  return out;
}

function cubic(p0, p1, p2, p3, steps, push) {
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    const a = u * u * u,
      b = 3 * u * u * t,
      c = 3 * u * t * t,
      e = t * t * t;
    push(a * p0[0] + b * p1[0] + c * p2[0] + e * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + e * p3[1]);
  }
}

/** Flatten one `d` string into an array of subpath polygons [[ [x,y], … ], …]. */
function flatten(d, steps = 28) {
  const t = tokenize(d);
  const polys = [];
  let poly = null;
  let cx = 0,
    cy = 0,
    sx = 0,
    sy = 0;
  let i = 0;
  const push = (x, y) => poly.push([(cx = x), (cy = y)]);
  while (i < t.length) {
    const cmd = t[i++];
    switch (cmd) {
      case 'M':
        poly = [];
        polys.push(poly);
        sx = t[i++];
        sy = t[i++];
        push(sx, sy);
        break;
      case 'L':
        push(t[i++], t[i++]);
        break;
      case 'H':
        push(t[i++], cy);
        break;
      case 'V':
        push(cx, t[i++]);
        break;
      case 'C': {
        const p0 = [cx, cy];
        const p1 = [t[i++], t[i++]];
        const p2 = [t[i++], t[i++]];
        const p3 = [t[i++], t[i++]];
        cubic(p0, p1, p2, p3, steps, push);
        break;
      }
      case 'Z':
        push(sx, sy);
        break;
      default:
        break;
    }
  }
  return polys;
}

// ── Rasterize ───────────────────────────────────────────────────────────────

/** Even-odd: is point (px,py) inside the union of polygons? */
function inside(polys, px, py) {
  let wind = 0;
  for (const poly of polys) {
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i];
      const [xj, yj] = poly[j];
      if (yi > py !== yj > py) {
        const xc = ((xj - xi) * (py - yi)) / (yj - yi) + xi;
        if (px < xc) wind ^= 1;
      }
    }
  }
  return wind === 1;
}

/**
 * Render polygons (in SVG user units `vw × vh`) into a `cols`-wide coverage
 * grid. Terminal cells are ~2× taller than wide, so we squash rows by
 * `charAspect`. Each cell is supersampled `ss × ss` for smooth coverage.
 */
function rasterize(polys, vw, vh, cols, opts) {
  return rasterizeBB(polys, [0, 0, vw, vh], cols, opts);
}

/** Tight bounding box [minX, minY, maxX, maxY] of every polygon point. */
function bboxOf(polys) {
  let ax = Infinity, ay = Infinity, bx = -Infinity, by = -Infinity;
  for (const p of polys)
    for (const [x, y] of p) {
      if (x < ax) ax = x;
      if (y < ay) ay = y;
      if (x > bx) bx = x;
      if (y > by) by = y;
    }
  return [ax, ay, bx, by];
}

/** Same as rasterize but over an explicit bbox (lets us crop the wordmark out
 * of the logomark SVG and rasterize just the letters). */
function rasterizeBB(polys, [ax, ay, bx, by], cols, { charAspect = 2.05, ss = 4, pad = 0.06 } = {}) {
  const vw = bx - ax;
  const vh = by - ay;
  const padX = vw * pad;
  const padY = vh * pad;
  const W = vw + padX * 2;
  const H = vh + padY * 2;
  const rows = Math.max(1, Math.round((cols * (H / W)) / charAspect));
  const grid = [];
  for (let r = 0; r < rows; r++) {
    const row = [];
    for (let c = 0; c < cols; c++) {
      let hit = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const px = ax - padX + ((c + (sx + 0.5) / ss) / cols) * W;
          const py = ay - padY + ((r + (sy + 0.5) / ss) / rows) * H;
          if (inside(polys, px, py)) hit++;
        }
      }
      row.push(hit / (ss * ss));
    }
    grid.push(row);
  }
  return grid;
}

// ── Coverage grid → characters ──────────────────────────────────────────────

const RAMPS = {
  solid: (v) => (v >= 0.5 ? '█' : ' '),
  shaded: (v) => ' ░▒▓█'[Math.min(4, Math.round(v * 4))],
  fine: (v) => ' .:-=+*#%@'[Math.min(9, Math.round(v * 9))],
  dots: (v) => (v >= 0.66 ? '●' : v >= 0.25 ? '•' : v > 0.04 ? '·' : ' '),
};

/** A coverage grid → array of trimmed text rows. */
function toRows(grid, ramp) {
  const f = RAMPS[ramp];
  return grid.map((row) => row.map(f).join('').replace(/\s+$/, ''));
}

/** Render at HALF vertical resolution using ▀ ▄ █ so each char = 2 px rows. */
function halfRows(grid) {
  const rows = grid.length;
  const cols = grid[0]?.length ?? 0;
  const out = [];
  for (let r = 0; r < rows; r += 2) {
    let line = '';
    for (let c = 0; c < cols; c++) {
      const top = (grid[r]?.[c] ?? 0) >= 0.5;
      const bot = (grid[r + 1]?.[c] ?? 0) >= 0.5;
      line += top && bot ? '█' : top ? '▀' : bot ? '▄' : ' ';
    }
    out.push(line.replace(/\s+$/, ''));
  }
  return out;
}

/** Threshold a coverage grid to a boolean fill grid (1 = inside). */
function fillGrid(grid) {
  return grid.map((row) => row.map((v) => (v >= 0.5 ? 1 : 0)));
}

/**
 * "ANSI Shadow" extrude — the exact 3D bevel the KORTIX wordmark uses. Draws the
 * solid █ body, then traces a thin box-drawing outline (╗ ║ ═ ╝ ╚) down the
 * RIGHT and BOTTOM edges so the symbol gets the same extruded/shadowed look as
 * the wordmark and the two sit together as one lockup. Needs size to read (the
 * radial blades collapse below ~w20); pair with a large symbol.
 */
function ansiShadow(fill) {
  const R = fill.length;
  const C = fill[0].length;
  const f = (r, c) => (r >= 0 && r < R && c >= 0 && c < C ? fill[r][c] : 0);
  const out = Array.from({ length: R + 1 }, () => Array(C + 1).fill(' '));
  for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) if (f(r, c)) out[r][c] = '█';
  for (let r = 0; r <= R; r++) {
    for (let c = 0; c <= C; c++) {
      if (out[r][c] === '█') continue;
      const left = f(r, c - 1); // filled to the left → this is a right edge
      const up = f(r - 1, c); //   filled above    → this is a bottom edge
      const ul = f(r - 1, c - 1); // diagonal, picks corner vs. continuation
      if (!left && !up && !ul) continue;
      if (left && up) out[r][c] = '╝';
      else if (left) out[r][c] = ul ? '║' : '╗';
      else if (up) out[r][c] = ul ? '═' : '╚';
      else out[r][c] = '╝';
    }
  }
  return out.map((row) => row.join('').replace(/\s+$/, ''));
}

const text = (rows) => rows.join('\n').replace(/^\n+/, '').replace(/\n+$/, '');
const cpLen = (s) => [...s].length;

// ── Lockup: real symbol  +  KORTIX wordmark ─────────────────────────────────

const WORDMARK = readFileSync(WORDMARK_TXT, 'utf8').replace(/\n+$/, '').split('\n');

/**
 * Place two row-blocks side by side, each vertically centered against the
 * taller of the two, with `gap` spaces between. Used to build every lockup.
 */
function combine(aRows, bRows, { gap = 3 } = {}) {
  const aw = Math.max(0, ...aRows.map(cpLen));
  const total = Math.max(aRows.length, bRows.length);
  const aTop = Math.floor((total - aRows.length) / 2);
  const bTop = Math.floor((total - bRows.length) / 2);
  const padTo = (s, w) => s + ' '.repeat(Math.max(0, w - cpLen(s)));
  const out = [];
  for (let i = 0; i < total; i++) {
    const a = i - aTop >= 0 && i - aTop < aRows.length ? aRows[i - aTop] : '';
    const b = i - bTop >= 0 && i - bTop < bRows.length ? bRows[i - bTop] : '';
    out.push((padTo(a, aw) + ' '.repeat(gap) + b).replace(/\s+$/, ''));
  }
  return out.join('\n');
}

/** symbol block + the figlet KORTIX wordmark. */
const lockup = (symRows, opts) => combine(symRows, WORDMARK, opts);

// ── Build everything ────────────────────────────────────────────────────────

const symbol = readSvg(SYMBOL_SVG);
const logomark = readSvg(LOGOMARK_SVG);
const symP = symbol.ds.flatMap((d) => flatten(d));
const logoP = logomark.ds.flatMap((d) => flatten(d));
// The "Kortix" letters only = the logomark minus its first path (the symbol).
const wordP = logomark.ds.slice(1).flatMap((d) => flatten(d));
const wordBB = bboxOf(wordP);

const sym = (cols, ramp, opts) => text(toRows(rasterize(symP, symbol.width, symbol.height, cols, opts), ramp));
const symHalf = (cols) => text(halfRows(rasterize(symP, symbol.width, symbol.height, cols, { charAspect: 1.0 })));
// Beveled rows (array) — solid body + ANSI-shadow outline. Symbol and wordmark
// rasterized the same way so a beveled lockup is internally consistent.
const symShadowRows = (cols, opts) => ansiShadow(fillGrid(rasterize(symP, symbol.width, symbol.height, cols, opts)));
const wordShadowRows = (cols, opts) => ansiShadow(fillGrid(rasterizeBB(wordP, wordBB, cols, opts)));
const logo = (cols, ramp, opts) => text(toRows(rasterize(logoP, logomark.width, logomark.height, cols, opts), ramp));
const logoHalf = (cols) => text(halfRows(rasterize(logoP, logomark.width, logomark.height, cols, { charAspect: 1.0 })));

// Every named variation. Key = constant name in the generated module.
//
// CURATION: `solid` block renders below ~w32 are intentionally NOT generated —
// at small sizes the radial blades collapse into an unreadable hash. For small
// sizes use half-block (▀ ▄ █), which carries 2× the vertical detail. Same goes
// for the lockup + logomark: only the half-block / shaded variants are kept.
const ART = {
  // ── Lockups (these are what the CLI banner rotates through) ──
  // Flat, compact (6 rows): half-block symbol flush with the figlet wordmark —
  // symbol and word the same size.
  LOCKUP_HALF: lockup(halfRows(rasterize(symP, symbol.width, symbol.height, 14, { charAspect: 1.0, pad: 0.05 }))),
  // Beveled, matched: symbol AND wordmark both rasterized + extruded in the same
  // ANSI-shadow style, sized to the same height. One consistent 3D lockup.
  LOCKUP_BEVEL: combine(symShadowRows(26), wordShadowRows(54)),
  WORDMARK: WORDMARK.join('\n'),

  // ── Standalone symbol, beveled (only L — small/medium press together) ──
  SYMBOL_SHADOW_L: text(symShadowRows(32)),

  // ── Standalone symbol, other styles ──
  SYMBOL_HALF_M: symHalf(22),
  SYMBOL_HALF_L: symHalf(34),
  SYMBOL_SOLID_L: sym(32, 'solid'),
  SYMBOL_SOLID_XL: sym(48, 'solid'),
  SYMBOL_SHADED_M: sym(22, 'shaded'),
  SYMBOL_SHADED_L: sym(34, 'shaded'),
  SYMBOL_FINE_M: sym(28, 'fine'),
  SYMBOL_DOTS_M: sym(24, 'dots'),

  // ── Full logomark (symbol + "Kortix" both rasterized from the SVG) ──
  LOGOMARK_HALF_L: logoHalf(80),
  LOGOMARK_SHADED_L: logo(80, 'shaded'),
};

// ── Catalog (.md) ───────────────────────────────────────────────────────────

const SECTIONS = [
  ['Lockups — symbol + KORTIX', 'Pair the mark with the wordmark. `LOCKUP_HALF` = flat half-block, symbol same size as the word; `LOCKUP_BEVEL` = both rasterized + 3D-extruded at matched size. (The CLI banner itself uses the full logomark — see below.)', [
    ['lockup · halfblock (flat, matched size)', 'LOCKUP_HALF'],
    ['lockup · bevel (3D, matched size)', 'LOCKUP_BEVEL'],
    ['wordmark only (KORTIX, figlet)', 'WORDMARK'],
  ]],
  ['The symbol — ANSI-shadow bevel (`█ ╗ ║ ═ ╝ ╚`)', 'The symbol in the wordmark\'s extruded style. Only L — smaller sizes press the radial blades together.', [
    ['symbol · shadow · L (w=32)', 'SYMBOL_SHADOW_L'],
  ]],
  ['The symbol — half-block (`▀ ▄ █`, 2× vertical detail)', 'Flat go-to symbol style. Each glyph packs two pixel rows, so the radial blades stay crisp even at small sizes.', [
    ['symbol · halfblock · M', 'SYMBOL_HALF_M'],
    ['symbol · halfblock · L', 'SYMBOL_HALF_L'],
  ]],
  ['The symbol — solid blocks (`█`)', 'Only large sizes — solid loses the blades when small (small solid is intentionally excluded; use half-block instead).', [
    ['symbol · solid · L (w=32)', 'SYMBOL_SOLID_L'],
    ['symbol · solid · XL (w=48)', 'SYMBOL_SOLID_XL'],
  ]],
  ['The symbol — shaded (`░ ▒ ▓ █`)', 'Soft anti-aliased look.', [
    ['symbol · shaded · M', 'SYMBOL_SHADED_M'],
    ['symbol · shaded · L', 'SYMBOL_SHADED_L'],
  ]],
  ['The symbol — fine ramp (` .:-=+*#%@`)', 'ASCII-only (no Unicode blocks) — safest for legacy terminals.', [
    ['symbol · fine · M', 'SYMBOL_FINE_M'],
  ]],
  ['The symbol — dots (`· • ●`)', 'Stippled / playful.', [
    ['symbol · dots · M', 'SYMBOL_DOTS_M'],
  ]],
  ['Full logomark — symbol + "Kortix" (100% rasterized SVG)  ★ (the CLI banner)', '`LOGOMARK_HALF_L` is what `kortix` prints on startup — the official lockup straight from the brand file, one consistent half-block style. Only half-block / shaded are kept (solid renders the wordmark too rough at terminal size).', [
    ['logomark · halfblock · L  ★', 'LOGOMARK_HALF_L'],
    ['logomark · shaded · L', 'LOGOMARK_SHADED_L'],
  ]],
];

let md = `# Kortix ASCII brand art

> **Auto-generated** by \`apps/web/playground/kortix-ascii/generate.mjs\` from the official
> brand SVGs in \`apps/web/public/brandkit\`. Same technique as the game-of-life
> landing canvas: rasterize the real mark, sample coverage, emit characters.
>
> Source: Brandmark (symbol) \`${symbol.width}×${symbol.height}\` · Logomark
> (symbol + wordmark) \`${logomark.width}×${logomark.height}\`.

## ⚠️ How to use this art — COPY IT, NEVER WRITE IT

These are box-drawing / half-block glyphs (\`▀ ▄ █ ╗ ╔ ╝ ░ ▒ ▓\`). **If you are an
LLM/agent you CANNOT reproduce them by typing** — next-token prediction silently
corrupts the alignment (shifted \`▀▄\`, broken \`╗╔╝\`, ragged columns). Every time
you "redraw" it, it gets worse.

**The rule: never hand-write this art. Always copy it byte-for-byte, line by line.**

- **In code** → \`import { LOCKUP_HALF } from './ascii-logo.generated.ts';\`. Import
  the constant; never paste the glyphs inline.
- **Anywhere else** (docs, another file, a chat message) → open the source file,
  select the exact lines, paste them **unchanged**. Do not re-align, "clean up",
  fix, or retype a single character.
- **To change the art** → edit/run \`generate.mjs\`. Never edit the
  generated output (\`ascii-logo.md\`, \`ascii-logo.generated.ts\`) by hand.

## Curation — what NOT to use

Some renders look like ass and were **removed on purpose**, so this catalog only
contains art that's actually good:

- **No small \`solid\` symbols** (w<32) — the radial blades collapse into a
  blocky hash. Use **half-block** for small sizes; it has 2× the vertical detail.
- **No \`solid\` lockup / logomark** — the symbol/wordmark go mushy. Half-block and
  shaded only.

---
`;

for (const [title, blurb, items] of SECTIONS) {
  md += `\n## ${title}\n\n${blurb}\n`;
  for (const [label, key] of items) {
    md += `\n### ${label}\n\n\`\`\`\n${ART[key]}\n\`\`\`\n`;
  }
  md += `\n---\n`;
}

md += `\n_Regenerate: \`node apps/web/playground/kortix-ascii/generate.mjs --write\`._\n`;

// ── Generated TS module ─────────────────────────────────────────────────────

let ts = `// AUTO-GENERATED by apps/web/playground/kortix-ascii/generate.mjs — DO NOT EDIT BY HAND.
// Run \`node apps/web/playground/kortix-ascii/generate.mjs --write\` to regenerate.
// Exact Kortix brand ASCII art rasterized from apps/web/public/brandkit.
//
// HOW TO USE: import these constants — never retype the glyphs. They are
// box-drawing / half-block characters; an LLM that hand-writes them WILL corrupt
// the alignment. Copy byte-for-byte or import; do not redraw. Full catalog +
// rules in ascii-logo.md.
/* eslint-disable */

`;
for (const [key, value] of Object.entries(ART)) {
  ts += `export const ${key} = ${JSON.stringify(value)};\n`;
}

if (process.argv.includes('--write')) {
  writeFileSync(resolve(__dirname, 'ascii-logo.md'), md);
  writeFileSync(resolve(__dirname, 'ascii-logo.generated.ts'), ts);
  console.log('wrote ascii-logo.md and ascii-logo.generated.ts');
} else {
  process.stdout.write(md);
}
