/**
 * Bakes assets/brand/kortix-heatmap.png, the texture the metallic-logo shader
 * samples. Run: `bun scripts/bake-heatmap.ts` (or `pnpm bake:heatmap`).
 *
 * Same steps as Paper's `toProcessedHeatmap`: symbol on a white square with
 * PADDING all round, gray, then the three blurs packed into R, G, B, then
 * downscaled to PLANE px and written as three gray planes side by side (see
 * `splitPlanes` for why). The shader reads the plane size from the PNG size.
 */
const PLANE = 1000;
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

import { CANVAS_SIZE, PADDING, packHeatmap, splitPlanes } from '../lib/effects/heatmap-bake';

const root = path.join(import.meta.dir, '..');
const svgPath = path.join(root, 'assets/brand/kortix-symbol.svg');
const outPath = path.join(root, 'assets/brand/kortix-heatmap.png');

const symbol = await sharp(readFileSync(svgPath), { density: 600 })
  .resize(CANVAS_SIZE, CANVAS_SIZE, { fit: 'inside', background: '#ffffff' })
  .flatten({ background: '#ffffff' })
  .png()
  .toBuffer();
const symbolMeta = await sharp(symbol).metadata();

const size = CANVAS_SIZE + 2 * PADDING;
const left = Math.round((size - (symbolMeta.width ?? CANVAS_SIZE)) / 2);
const top = Math.round((size - (symbolMeta.height ?? CANVAS_SIZE)) / 2);

const { data, info } = await sharp({ create: { width: size, height: size, channels: 3, background: '#ffffff' } })
  .composite([{ input: symbol, left, top }])
  .removeAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });
const ch = info.channels;

const gray = new Uint8ClampedArray(size * size);
for (let i = 0; i < gray.length; i++) {
  gray[i] = (0.299 * data[i * ch]! + 0.587 * data[i * ch + 1]! + 0.114 * data[i * ch + 2]!) | 0;
}

const rgba = packHeatmap(gray, size, size, CANVAS_SIZE);
const scaled = await sharp(Buffer.from(rgba.buffer), { raw: { width: size, height: size, channels: 4 } })
  .resize(PLANE, PLANE, { kernel: 'lanczos3' })
  .raw()
  .toBuffer();
const atlas = splitPlanes(new Uint8ClampedArray(scaled), PLANE, PLANE);
const png = await sharp(Buffer.from(atlas.buffer), { raw: { width: PLANE * 3, height: PLANE, channels: 1 } })
  .png({ compressionLevel: 9 })
  .toBuffer();
writeFileSync(outPath, png);
console.log(`wrote ${path.relative(root, outPath)}: ${PLANE * 3}x${PLANE} gray, ${png.length} bytes`);
