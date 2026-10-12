// One-off: rasterize apps/web/public/kortix-symbol.svg into icons/{16,32,48,128}.png.
// Ink tile + white symbol so the icon reads on light and dark toolbars. Run: bun run scripts/icons.ts
import { createRequire } from 'node:module';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '../../..');
const sharp = createRequire(join(root, 'node_modules/.pnpm/sharp@0.35.5_@types+node@20.19.43/node_modules/sharp/'))('sharp');
const svg = readFileSync(join(root, 'apps/web/public/kortix-symbol.svg'), 'utf8');
const path = svg.match(/<path d="([^"]+)"/)![1];
const INK = '#1f1f1f'; // --primary in tokens.css
mkdirSync(join(import.meta.dir, '../icons'), { recursive: true });

for (const size of [16, 32, 48, 128]) {
  // Symbol is 30x25; scale to 56% of the tile width and center.
  const w = size * 0.56, s = w / 30, h = 25 * s;
  const tile = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <rect width="${size}" height="${size}" rx="${size * 0.22}" fill="${INK}"/>
    <g transform="translate(${(size - w) / 2} ${(size - h) / 2}) scale(${s})"><path d="${path}" fill="#fff"/></g></svg>`;
  const png = await sharp(Buffer.from(tile), { density: 384 }).resize(size, size).png().toBuffer();
  writeFileSync(join(import.meta.dir, `../icons/${size}.png`), png);
}
console.log('icons written');
