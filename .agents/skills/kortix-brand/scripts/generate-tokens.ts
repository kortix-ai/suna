#!/usr/bin/env bun
// Generates every CSS token file from references/visual/visual-system.json.
//
//   bun .agents/skills/kortix-brand/scripts/generate-tokens.ts           write
//   bun .agents/skills/kortix-brand/scripts/generate-tokens.ts --check   exit 1 on drift
//
// It rewrites ONLY marker-delimited regions in apps/web/src/app/globals.css and
// apps/mobile/global.css, and whole-file outputs under references/visual/.
// Stdlib only.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const VISUAL = join(ROOT, '.agents/skills/kortix-brand/references/visual');
const JSON_PATH = join(VISUAL, 'visual-system.json');
const WEB_CSS = join(ROOT, 'apps/web/src/app/globals.css');
const MOBILE_CSS = join(ROOT, 'apps/mobile/global.css');

const EDIT_HINT =
  'edit .agents/skills/kortix-brand/references/visual/visual-system.json, then run generate-tokens.ts';
const END_MARKER = '/* @generated kortix-brand:end */';
const startMarker = (id: string) =>
  `/* @generated kortix-brand:start${id ? ` ${id}` : ''} — ${EDIT_HINT} */`;

// ───────────────────────────── types ─────────────────────────────
type Theme = 'light' | 'dark';
type Entry = {
  light?: string | { ref: string };
  dark?: string | { ref: string };
  value?: string;
  ref?: string;
  hex?: (string | null)[];
  ramp?: string;
  mobile?: boolean;
  mobile_aliases?: string[];
  web_value?: string;
  mobile_value?: string;
};
type Token = { name: string; entry: Entry; group: string };

const vs = JSON.parse(readFileSync(JSON_PATH, 'utf8'));

// ───────────────────────── color math ─────────────────────────
type Rgba = { r: number; g: number; b: number; a: number };
const gamma = (v: number) =>
  v <= 0.0031308 ? 12.92 * v : 1.055 * Math.sign(v) * Math.abs(v) ** (1 / 2.4) - 0.055;
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

function parseColor(v: string): Rgba {
  let m = v.match(/^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+))?\)$/);
  if (m) {
    const L = m[2] ? Number(m[1]) / 100 : Number(m[1]);
    const C = Number(m[3]);
    const H = (Number(m[4]) * Math.PI) / 180;
    const A = C * Math.cos(H);
    const B = C * Math.sin(H);
    const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
    const mm = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
    const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
    const [r, g, b] = [
      gamma(4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * s),
      gamma(-1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * s),
      gamma(-0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * s),
    ].map(clamp01);
    return { r, g, b, a: m[5] ? Number(m[5]) : 1 };
  }
  m = v.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (m) {
    const [r, g, b] = m.slice(1, 4).map((x) => parseInt(x, 16) / 255);
    return { r, g, b, a: 1 };
  }
  m = v.match(/^rgb\((\d+) (\d+) (\d+)(?: \/ ([\d.]+))?\)$/);
  if (m) {
    const [r, g, b] = m.slice(1, 4).map((x) => Number(x) / 255);
    return { r, g, b, a: m[4] ? Number(m[4]) : 1 };
  }
  throw new Error(`generate-tokens: cannot parse color "${v}"`);
}

const toHex = ({ r, g, b }: Rgba) =>
  `#${[r, g, b].map((x) => Math.round(x * 255).toString(16).padStart(2, '0')).join('')}`;

function toHsl({ r, g, b, a }: Rgba): string {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  const d = mx - mn;
  let h = 0;
  let s = 0;
  if (d > 1e-9) {
    s = d / (1 - Math.abs(2 * l - 1));
    h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const f = (n: number) => String(Number(n.toFixed(1)));
  return `${s * 100 < 0.05 ? 0 : f(h)} ${f(s * 100)}% ${f(l * 100)}%${a === 1 ? '' : ` / ${a}`}`;
}

/** Portable color string: hex when opaque, rgb() with slash alpha otherwise. */
function portable(c: Rgba): string {
  if (c.a === 1) return toHex(c);
  const [r, g, b] = [c.r, c.g, c.b].map((x) => Math.round(x * 255));
  return `rgb(${r} ${g} ${b} / ${c.a})`;
}

// ───────────────────────── token model ─────────────────────────
function tokens(): Token[] {
  const out: Token[] = [];
  const add = (group: string, obj: Record<string, Entry>) => {
    for (const [name, entry] of Object.entries(obj)) {
      if (name === 'rule') continue;
      out.push({ name, entry, group });
    }
  };
  add('semantic', vs.color.semantic);
  add('accents', vs.color.accents);
  add('status', vs.color.status_mobile_only);
  add('chart', vs.color.chart);
  add('terminal', vs.color.terminal);
  return out;
}
const TOKENS = tokens();
for (const t of TOKENS) if (typeof t.entry.hex === 'string') t.entry.hex = [t.entry.hex, t.entry.hex];
const byName = new Map(TOKENS.map((t) => [t.name, t]));

type Side = string | { ref: string } | undefined;
function side(e: Entry, theme: Theme): Side {
  if (e.ref) return { ref: e.ref };
  if (e.value !== undefined) return e.value;
  return e[theme] ?? e.light;
}

/** CSS declaration value for the web (refs stay var()). */
function webValue(t: Token, theme: Theme): string {
  const s = side(t.entry, theme);
  if (t.entry.web_value) return t.entry.web_value;
  if (s && typeof s === 'object') return `var(--${s.ref})`;
  return s as string;
}
function mobileValue(t: Token, theme: Theme): string {
  const s = side(t.entry, theme);
  if (t.entry.mobile_value) return t.entry.mobile_value;
  if (t.name === 'chrome-background') return 'var(--sidebar)';
  if (s && typeof s === 'object') return `var(--${s.ref})`;
  return toHsl(parseColor(s as string));
}
/** Resolve a token to a concrete color for a theme (follows refs). */
function resolveColor(name: string, theme: Theme): Rgba {
  const t = byName.get(name);
  if (!t) throw new Error(`generate-tokens: unknown token ${name}`);
  const s = side(t.entry, theme);
  if (s && typeof s === 'object') return resolveColor(s.ref, theme);
  return parseColor(s as string);
}
const isRef = (t: Token, theme: Theme) => {
  const s = side(t.entry, theme);
  return t.entry.web_value !== undefined || (s !== null && typeof s === 'object');
};

// ───────────────────────── validation ─────────────────────────
function validate(): string[] {
  const errors: string[] = [];
  for (const t of TOKENS) {
    if (!t.entry.hex) continue;
    (['light', 'dark'] as Theme[]).forEach((theme, i) => {
      const want = t.entry.hex?.[i];
      if (!want) return;
      const got = toHex(resolveColor(t.name, theme));
      if (got !== want) errors.push(`${t.name} ${theme}: hex ${want} does not match computed ${got}`);
    });
  }
  return errors;
}

// ───────────────────────── web generators ─────────────────────────
const comment = (t: Token, theme: Theme): string => {
  const hex = t.entry.hex?.[theme === 'light' ? 0 : 1];
  const bits = [t.entry.ramp, hex].filter(Boolean).join(' ');
  return bits ? ` /* ${bits} */` : '';
};

function webRootAndDark(): string {
  const lines: string[] = [];
  const decl = (n: string, v: string, c = '') => `  --${n}: ${v};${c}`;

  lines.push(':root {');
  for (const t of TOKENS) {
    if (t.group === 'status') continue; // mobile only
    lines.push(decl(t.name, webValue(t, 'light'), comment(t, 'light')));
  }
  lines.push(decl('radius', vs.radius.base));
  lines.push(decl('tracking-normal', vs.typography.tracking.normal));
  lines.push(decl('spacing', vs.spacing.web_base));
  for (const [k, v] of Object.entries<any>(vs.motion.duration)) lines.push(decl(`duration-${k}`, `${v.ms}ms`));
  for (const [k, v] of Object.entries<any>(vs.motion.easing))
    lines.push(decl(`ease-${k}`, `cubic-bezier(${v.bezier.join(', ')})`));
  const g = vs.effects['liquid-glass'];
  lines.push(decl('liquid-glass-bg', g.bg[0]));
  lines.push(decl('liquid-glass-bg-hover', g['bg-hover'][0]));
  lines.push(decl('liquid-glass-blur', g.blur));
  lines.push(decl('liquid-glass-saturate', g.saturate));
  lines.push(decl('liquid-glass-shadow', g.shadow[0]));
  lines.push(decl('liquid-glass-highlight', g.highlight[0]));
  lines.push('}', '', '.dark {');
  // .dark re-declares a token only when its value differs from :root, or when
  // it is a var() reference. A nested .dark subtree must re-resolve references.
  for (const t of TOKENS) {
    if (t.group === 'status') continue;
    const light = webValue(t, 'light');
    const dark = webValue(t, 'dark');
    if (dark !== light || isRef(t, 'dark')) lines.push(decl(t.name, dark, comment(t, 'dark')));
  }
  lines.push(decl('liquid-glass-bg', g.bg[1]));
  lines.push(decl('liquid-glass-bg-hover', g['bg-hover'][1]));
  lines.push(decl('liquid-glass-shadow', g.shadow[1]));
  lines.push(decl('liquid-glass-highlight', g.highlight[1]));
  lines.push('}');
  return lines.join('\n');
}

function webTheme(): string {
  const L: string[] = [];
  L.push('/* Type scale. Roles and surfaces are in references/visual/typography.md. */');
  for (const [k, v] of Object.entries<any>(vs.typography.scale)) {
    L.push(`--text-${k}: ${v.size};`);
    L.push(`--text-${k}--line-height: ${v.line_height};`);
  }
  L.push(`/* ${vs.color.emoji.rule} */`);
  const pair = (name: string, p: [string, string]) => `--color-${name}: light-dark(${p[0]}, ${p[1]});`;
  for (const fam of ['fill', 'ring'])
    for (const [k, v] of Object.entries<any>(vs.color.emoji[fam])) L.push(pair(`emoji-${fam}-${k}`, v));
  L.push(`/* ${vs.color.glyph.rule} */`);
  for (const fam of ['fill', 'ring'])
    for (const [k, v] of Object.entries<any>(vs.color.glyph[fam])) L.push(pair(`glyph-${fam}-${k}`, v));
  L.push('/* Motion. Tailwind 4 reads duration utilities from --transition-duration-*. */');
  for (const [k, v] of Object.entries<any>(vs.motion.duration)) L.push(`--transition-duration-${k}: ${v.ms}ms;`);
  for (const [k, v] of Object.entries<any>(vs.motion.easing))
    L.push(`--ease-${k}: cubic-bezier(${v.bezier.join(', ')});`);
  return L.join('\n');
}

// ───────────────────────── mobile generators ─────────────────────────
function mobileBlock(theme: Theme): string {
  const L: string[] = [];
  const decl = (n: string, v: string, c = '') => `--${n}: ${v};${c}`;
  for (const t of TOKENS) {
    if (!t.entry.mobile) continue;
    const v = mobileValue(t, theme);
    const s = side(t.entry, theme);
    const src = typeof s === 'string' && !t.entry.mobile_value ? ` /* ${s} */` : '';
    L.push(decl(t.name, v, src));
    for (const alias of t.entry.mobile_aliases ?? []) L.push(decl(alias, `var(--${t.name})`));
  }
  L.push(decl('radius', vs.radius.base));
  for (const [k, v] of Object.entries<string>(vs.mobile.extra_declarations)) L.push(decl(k, v));
  return L.join('\n');
}

// ───────────────────────── kit outputs ─────────────────────────
function kitTokens(): string {
  const L: string[] = [];
  L.push(
    '/* GENERATED from visual-system.json by .agents/skills/kortix-brand/scripts/generate-tokens.ts. Do not edit.',
    '   Portable Kortix tokens for HTML, email, OG images and decks outside apps/web.',
    '   Light is the default. Dark follows prefers-color-scheme, or [data-theme="dark"] to force it.',
    '   Pair with fonts.css. Names match the app tokens (--background, --foreground, --kortix-green ...). */',
    ''
  );
  const colorLines = (theme: Theme, ind: string) => {
    const o: string[] = [];
    for (const t of TOKENS) {
      if (t.group === 'status' || t.name === 'focus-ring') continue;
      o.push(`${ind}--${t.name}: ${portable(resolveColor(t.name, theme))};`);
    }
    return o;
  };
  const shared: string[] = [];
  shared.push(`  --font-sans: ${vs.typography.stacks.sans};`);
  shared.push(`  --font-mono: ${vs.typography.stacks.mono};`);
  shared.push(`  --radius: ${vs.radius.base};`);
  for (const k of ['sm', 'md', 'lg', 'xl', '2xl']) shared.push(`  --radius-${k}: ${vs.radius.web[k].value};`);
  shared.push(`  --spacing: ${vs.spacing.web_base};`);
  for (const [k, v] of Object.entries<any>(vs.typography.scale)) {
    shared.push(`  --text-${k}: ${v.size};`, `  --text-${k}-line-height: ${v.line_height};`);
  }
  for (const [k, v] of Object.entries<any>(vs.elevation.steps)) shared.push(`  --shadow-${k}: ${v.value};`);
  for (const [k, v] of Object.entries<any>(vs.motion.duration)) shared.push(`  --duration-${k}: ${v.ms}ms;`);
  for (const [k, v] of Object.entries<any>(vs.motion.easing))
    shared.push(`  --ease-${k}: cubic-bezier(${v.bezier.join(', ')});`);
  L.push(':root {', '  color-scheme: light;', ...colorLines('light', '  '), ...shared, '}', '');
  L.push(':root[data-theme="dark"] {', '  color-scheme: dark;', ...colorLines('dark', '  '), '}', '');
  L.push(
    '@media (prefers-color-scheme: dark) {',
    '  :root:not([data-theme="light"]) {',
    '    color-scheme: dark;',
    ...colorLines('dark', '    '),
    '  }',
    '}',
    ''
  );
  return L.join('\n');
}

function kitFonts(): string {
  const L: string[] = [];
  L.push(
    '/* GENERATED from visual-system.json by .agents/skills/kortix-brand/scripts/generate-tokens.ts. Do not edit.',
    '   Roobert and Roobert Mono as variable fonts, served by the Kortix site.',
    '   OPEN (decisions.md, D8): the license for public redistribution of Roobert is not confirmed.',
    '   Use these URLs for Kortix-owned surfaces only until the license is confirmed. */',
    ''
  );
  for (const fam of Object.values<any>(vs.typography.families)) {
    for (const path of fam.web_files as string[]) {
      const file = basename(path);
      if (!existsSync(join(ROOT, path))) throw new Error(`generate-tokens: font file missing: ${path}`);
      const italic = /Italics/.test(file);
      L.push(
        '@font-face {',
        `  font-family: '${fam.name}';`,
        `  src: url('https://kortix.com/fonts/roobert/${file}') format('woff2');`,
        `  font-style: ${italic ? 'italic' : 'normal'};`,
        '  font-weight: 100 900;',
        '  font-display: swap;',
        `  font-feature-settings: ${vs.typography.feature_settings_font_face};`,
        '}',
        ''
      );
    }
  }
  return L.join('\n');
}

// ───────────────────────── region rewriting ─────────────────────────
const START_RE = /^(\s*)\/\* @generated kortix-brand:start(?: ([a-z-]+))? — .*\*\/\s*$/;

function rewriteRegions(file: string, bodies: Record<string, string>): string {
  const src = readFileSync(file, 'utf8').split('\n');
  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < src.length; i++) {
    const m = src[i].match(START_RE);
    if (!m) {
      out.push(src[i]);
      continue;
    }
    const indent = m[1];
    const id = m[2] ?? '';
    if (!(id in bodies)) throw new Error(`generate-tokens: ${relative(ROOT, file)} has unknown region "${id}"`);
    let end = -1;
    for (let j = i + 1; j < src.length; j++) {
      if (src[j].trim() === END_MARKER) {
        end = j;
        break;
      }
    }
    if (end < 0) throw new Error(`generate-tokens: ${relative(ROOT, file)} region "${id}" has no end marker`);
    out.push(`${indent}${startMarker(id)}`);
    for (const line of bodies[id].split('\n')) out.push(line ? `${indent}${line}` : '');
    out.push(`${indent}${END_MARKER}`);
    seen.add(id);
    i = end;
  }
  for (const id of Object.keys(bodies))
    if (!seen.has(id)) throw new Error(`generate-tokens: ${relative(ROOT, file)} is missing region "${id}"`);
  return out.join('\n');
}

// ───────────────────────── main ─────────────────────────
const errors = validate();
if (errors.length) {
  console.error(`generate-tokens: ${errors.length} hex field(s) disagree with their oklch value:`);
  for (const e of errors) console.error(`  ${e}`);
  process.exit(2);
}

const outputs: Record<string, string> = {
  [WEB_CSS]: rewriteRegions(WEB_CSS, { '': webRootAndDark(), theme: webTheme() }),
  [MOBILE_CSS]: rewriteRegions(MOBILE_CSS, {
    'mobile-light': mobileBlock('light'),
    'mobile-dark': mobileBlock('dark'),
  }),
  [join(VISUAL, 'tokens.css')]: kitTokens(),
  [join(VISUAL, 'fonts.css')]: kitFonts(),
};

const check = process.argv.includes('--check');
const drifted: string[] = [];
for (const [file, content] of Object.entries(outputs)) {
  const current = existsSync(file) ? readFileSync(file, 'utf8') : null;
  if (current === content) continue;
  if (check) drifted.push(relative(ROOT, file));
  else {
    writeFileSync(file, content);
    console.log(`wrote ${relative(ROOT, file)}`);
  }
}
if (check) {
  if (drifted.length) {
    for (const f of drifted) console.error(`DRIFT: ${f}`);
    console.error('Run: bun .agents/skills/kortix-brand/scripts/generate-tokens.ts');
    process.exit(1);
  }
  console.log('generate-tokens: no drift');
} else if (!process.argv.includes('--quiet')) {
  console.log('generate-tokens: done');
}
