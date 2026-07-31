#!/usr/bin/env node
/**
 * Renders every downloadable Kortix wallpaper into `public/wallpapers/downloads`
 * and regenerates `src/lib/wallpaper-downloads.ts` (the manifest the
 * /design-system page reads).
 *
 * Two families:
 *
 * 1. `mark` — the brand wallpapers: the Kortix symbol, and the full logo
 *    lockup, each dead-centred on a solid brand field in black-on-white and
 *    white-on-black. Pure geometry, so both are drawn from the source SVGs in
 *    `public/brandkit/Logo` at each target size and stay exact at any
 *    resolution — nothing is ever upscaled from a raster.
 *
 * 2. `product` — the wallpapers you can set on a Kortix home
 *    (`src/lib/wallpapers.ts`). Five of the six are live WebGL compositions,
 *    so there is no file to copy: each one is rendered at the target pixel
 *    size in a real browser at `/debug/wallpaper` and the frame is captured.
 *    `prefers-reduced-motion: reduce` freezes every composition (speed 0), so
 *    the captured frame is the same frame on every run — no seed drift, no
 *    "whatever the animation happened to be doing". The Paper Shader pixel cap
 *    is lifted for the capture (`?px=`) so a 5K wallpaper is 5K pixels of
 *    shader, never a 2 MP canvas upscaled.
 *
 * Format is chosen per composition, not globally: the ordered-dither
 * compositions are hard-edged two-tone fields that PNG stores losslessly in
 * ~60 KB and JPEG would smear into ringing; the soft/organic ones are 8-9 MB
 * as PNG and ~0.5 MB as high-quality JPEG.
 *
 * Usage:
 *   pnpm --filter @kortix/web dev            # a dev server must be running
 *   node scripts/generate-wallpapers.mjs --base=http://localhost:3000
 *
 * Flags:
 *   --base=<url>   dev/prod server that serves /debug/wallpaper (required host)
 *   --only=<ids>   comma-separated ids to re-render (`symbol`, `logo`, or any
 *                  wallpaper id from src/lib/wallpapers.ts)
 *   --gpu=<mode>   `metal` (default, fast) or `swiftshader` (no GPU)
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(WEB_ROOT, 'public/wallpapers/downloads');
const MANIFEST = join(WEB_ROOT, 'src/lib/wallpaper-downloads.ts');
const BRANDKIT = join(WEB_ROOT, 'public/brandkit/Logo');

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const BASE = arg('base', 'http://localhost:3000').replace(/\/$/, '');
const ONLY = arg('only', '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const GPU = arg('gpu', 'metal');

/** Desktop 16:9 ladder plus the phone portrait everyone actually has. */
const SIZE_5K = { w: 5120, h: 2880, label: '5K' };
const SIZE_4K = { w: 3840, h: 2160, label: '4K' };
const SIZE_1440 = { w: 2560, h: 1440, label: '1440p' };
const SIZE_PHONE = { w: 1290, h: 2796, label: 'Phone' };

/**
 * The brand wallpaper is vector-cheap, so it ships the whole ladder. The
 * shader captures ship 5K (which downsamples cleanly to 4K/1440p in every OS
 * wallpaper picker) plus the phone portrait, which is a genuinely different
 * composition rather than a crop.
 */
const MARK_SIZES = [SIZE_5K, SIZE_4K, SIZE_1440, SIZE_PHONE];
const PRODUCT_SIZES = [SIZE_5K, SIZE_PHONE];

const THEMES = [
  { id: 'light', bg: '#FFFFFF', fg: '#0A0A0A', label: 'Light' },
  { id: 'dark', bg: '#0A0A0A', fg: '#FAFAFA', label: 'Dark' },
];

/** `png` keeps ordered dither exact; `jpeg` keeps soft gradients under a MB. */
const PRODUCT_WALLPAPERS = [
  { id: 'dither', name: 'Dither', format: 'png' },
  { id: 'brandmark', name: 'Brandmark', format: 'png' },
  { id: 'nebula', name: 'Pixel Beams', format: 'png' },
  { id: 'silk', name: 'Silk', format: 'jpeg' },
  { id: 'grain', name: 'Grain', format: 'jpeg' },
  { id: 'neuro', name: 'Neuro', format: 'jpeg' },
];

const JPEG_QUALITY = 92;
/** The card preview on /design-system: the real composition, small. */
const PREVIEW = { w: 960, h: 540, label: 'Preview' };
const PREVIEW_QUALITY = 78;
/**
 * The two brand wallpapers: the symbol alone, and the full logo lockup.
 *
 * `width` is the drawn mark's width as a share of the canvas width, and it is
 * split by orientation because one number cannot serve both. A 16:9 desktop is
 * ~1.8x wider than it is tall, so a share of its width reads much larger than
 * the same share on a 1290x2796 phone. The two ratios per family are fixed
 * across every size in that orientation, so the set looks deliberate.
 *
 * The logo carries a wordmark, so it needs more width than the symbol to stay
 * legible — and less presence than a glyph would take at the same width.
 */
const MARK_FAMILIES = [
  {
    id: 'symbol',
    name: 'Symbol',
    svg: join(BRANDKIT, 'Brandmark/SVG/Brandmark Black.svg'),
    width: { landscape: 0.085, portrait: 0.152 },
  },
  {
    id: 'logo',
    name: 'Logo',
    svg: join(BRANDKIT, 'Logomark/SVG/Logomark Black.svg'),
    width: { landscape: 0.16, portrait: 0.34 },
  },
];

const wanted = (id) => ONLY.length === 0 || ONLY.includes(id);
const ext = (format) => (format === 'jpeg' ? 'jpg' : 'png');

/**
 * A brand wallpaper page: the mark drawn from its source SVG, dead centre.
 *
 * Centring is done on the *ink*, not on the SVG box. Both source files carry a
 * fraction of a unit of asymmetric padding inside their viewBox, which is a
 * visible drift once it is scaled to 5120px. The page measures the union of the
 * path bounding boxes, re-crops the viewBox to exactly that, and rounds the
 * drawn box to even pixels so `(canvas - mark) / 2` is a whole number on both
 * axes. Nothing is ever rasterised and rescaled — every size is a fresh draw.
 */
function markPageHtml({ w, h, bg, fg, svgFile, widthRatio }) {
  const svg = readFileSync(svgFile, 'utf8').replace(/\n/g, '');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;width:${w}px;height:${h}px;background:${bg};overflow:hidden}
    body{position:relative}
    svg{position:absolute;display:block}
    svg path{fill:${fg}}
  </style></head><body>${svg}<script>
    (function () {
      var svg = document.querySelector('svg');
      var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      svg.querySelectorAll('path').forEach(function (p) {
        var b = p.getBBox();
        x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y);
        x1 = Math.max(x1, b.x + b.width); y1 = Math.max(y1, b.y + b.height);
      });
      var iw = x1 - x0, ih = y1 - y0;
      svg.setAttribute('viewBox', x0 + ' ' + y0 + ' ' + iw + ' ' + ih);
      var even = function (n) { return 2 * Math.round(n / 2); };
      var mw = even(${widthRatio} * ${w});
      var mh = even(mw * ih / iw);
      svg.setAttribute('width', mw);
      svg.setAttribute('height', mh);
      svg.style.left = (${w} - mw) / 2 + 'px';
      svg.style.top = (${h} - mh) / 2 + 'px';
      document.documentElement.setAttribute('data-mark-ready', '1');
    })();
  </script></body></html>`;
}

async function capture(page, { url, html, shader, format, quality }) {
  if (html) {
    await page.setContent(html, { waitUntil: 'load' });
    await page.waitForSelector('html[data-mark-ready]', { timeout: 30_000 });
  } else {
    // A dev server compiling a route can blow past any single navigation
    // timeout; one retry turns that into a slow capture instead of a dead run.
    for (let attempt = 1; ; attempt += 1) {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120_000 });
        await page.waitForSelector('html[data-wallpaper-ready]', { timeout: 60_000 });
        break;
      } catch (error) {
        if (attempt === 3) throw error;
        console.warn(`  retry ${attempt} — ${url}`);
      }
    }
    if (shader) await page.waitForSelector('canvas', { timeout: 60_000 });
    // Shader mount + first frames; with speed 0 the composition then holds.
    await page.waitForTimeout(4000);
  }
  return format === 'jpeg'
    ? page.screenshot({ type: 'jpeg', quality: quality ?? JPEG_QUALITY })
    : page.screenshot({ type: 'png' });
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch({
    args:
      GPU === 'metal'
        ? ['--use-angle=metal']
        : [
            '--disable-gpu',
            '--use-gl=angle',
            '--use-angle=swiftshader',
            '--enable-unsafe-swiftshader',
          ],
  });

  const entries = [];
  const previews = new Map();

  for (const theme of THEMES) {
    const context = await browser.newContext({
      viewport: { width: SIZE_5K.w, height: SIZE_5K.h },
      deviceScaleFactor: 1,
      reducedMotion: 'reduce',
      colorScheme: theme.id,
    });
    const page = await context.newPage();

    for (const family of MARK_FAMILIES) {
      if (!wanted(family.id)) continue;
      const shot = (size, format, quality) =>
        capture(page, {
          html: markPageHtml({
            w: size.w,
            h: size.h,
            bg: theme.bg,
            fg: theme.fg,
            svgFile: family.svg,
            widthRatio: size.w >= size.h ? family.width.landscape : family.width.portrait,
          }),
          format,
          quality,
        });

      for (const size of MARK_SIZES) {
        await page.setViewportSize({ width: size.w, height: size.h });
        const file = `kortix-${family.id}-${theme.id}-${size.w}x${size.h}.png`;
        const buf = await shot(size, 'png');
        writeFileSync(join(OUT_DIR, file), buf);
        entries.push({
          group: 'mark',
          id: family.id,
          name: family.name,
          theme: theme.id,
          size,
          file,
        });
        console.log(
          `${family.id} ${theme.id} ${size.w}x${size.h} → ${(buf.length / 1024).toFixed(0)} KB`,
        );
      }

      await page.setViewportSize({ width: PREVIEW.w, height: PREVIEW.h });
      const previewFile = `kortix-${family.id}-${theme.id}-preview.jpg`;
      writeFileSync(join(OUT_DIR, previewFile), await shot(PREVIEW, 'jpeg', PREVIEW_QUALITY));
      previews.set(`${family.id}-${theme.id}`, `/wallpapers/downloads/${previewFile}`);
    }

    for (const wallpaper of PRODUCT_WALLPAPERS) {
      if (!wanted(wallpaper.id)) continue;
      const shot = (size, format, quality) =>
        capture(page, {
          url: `${BASE}/debug/wallpaper?id=${wallpaper.id}&theme=${theme.id}&px=${size.w * size.h}`,
          shader: wallpaper.id !== 'brandmark',
          format,
          quality,
        });

      for (const size of PRODUCT_SIZES) {
        await page.setViewportSize({ width: size.w, height: size.h });
        const file = `kortix-${wallpaper.id}-${theme.id}-${size.w}x${size.h}.${ext(wallpaper.format)}`;
        const buf = await shot(size, wallpaper.format);
        writeFileSync(join(OUT_DIR, file), buf);
        entries.push({
          group: 'product',
          id: wallpaper.id,
          name: wallpaper.name,
          theme: theme.id,
          size,
          file,
        });
        console.log(
          `${wallpaper.id} ${theme.id} ${size.w}x${size.h} → ${(buf.length / 1024).toFixed(0)} KB`,
        );
      }

      // Card preview for /design-system — the real composition, not a mockup.
      await page.setViewportSize({ width: PREVIEW.w, height: PREVIEW.h });
      const previewFile = `kortix-${wallpaper.id}-${theme.id}-preview.jpg`;
      writeFileSync(join(OUT_DIR, previewFile), await shot(PREVIEW, 'jpeg', PREVIEW_QUALITY));
      previews.set(`${wallpaper.id}-${theme.id}`, `/wallpapers/downloads/${previewFile}`);
    }

    await context.close();
  }

  await browser.close();

  if (ONLY.length === 0) writeManifest(entries, previews);
  else console.log('\n--only run: manifest left untouched. Re-run without --only to refresh it.');

  const total = readdirSync(OUT_DIR).reduce((n, f) => n + statSync(join(OUT_DIR, f)).size, 0);
  console.log(
    `\n${readdirSync(OUT_DIR).length} files, ${(total / 1e6).toFixed(2)} MB in ${OUT_DIR}`,
  );
}

function writeManifest(entries, previews) {
  const byKey = new Map();
  for (const e of entries) {
    const key = `${e.id}-${e.theme}`;
    if (!byKey.has(key)) {
      byKey.set(key, {
        group: e.group,
        id: e.id,
        name: e.name,
        theme: e.theme,
        preview: previews.get(key) ?? '',
        files: [],
      });
    }
    byKey.get(key).files.push({
      label: e.size.label,
      width: e.size.w,
      height: e.size.h,
      href: `/wallpapers/downloads/${e.file}`,
      file: e.file,
      bytes: statSync(join(OUT_DIR, e.file)).size,
    });
  }

  const groups = [...byKey.values()];
  // Match the repo's prettier config: unquoted keys, single-quoted values.
  const body = JSON.stringify(groups, null, 2)
    .replace(/"([A-Za-z]\w*)":/g, '$1:')
    .replace(/"([^"\\]*)"/g, "'$1'");

  writeFileSync(
    MANIFEST,
    `// GENERATED by scripts/generate-wallpapers.mjs — do not edit by hand.
// Re-run it after changing any wallpaper composition.

export interface WallpaperDownloadFile {
  /** Human size label shown on the download chip, e.g. \`5K\`. */
  label: string;
  width: number;
  height: number;
  href: string;
  file: string;
  bytes: number;
}

export interface WallpaperDownload {
  /** \`mark\` = the brand wallpaper; \`product\` = a wallpaper you can set on a Kortix home. */
  group: 'mark' | 'product';
  id: string;
  name: string;
  theme: 'light' | 'dark';
  /** Small JPEG of this exact composition, for the card on /design-system. */
  preview: string;
  files: WallpaperDownloadFile[];
}

export const WALLPAPER_DOWNLOADS: WallpaperDownload[] = ${body};
`,
  );

  // The manifest is committed, so it has to satisfy `prettier --check` without
  // anyone remembering to run it.
  try {
    execFileSync('npx', ['prettier', '--write', MANIFEST], { cwd: WEB_ROOT, stdio: 'ignore' });
  } catch {
    console.warn('prettier --write failed on the manifest; run it by hand before committing.');
  }

  console.log(`\nmanifest → ${MANIFEST}`);
}

await main();
