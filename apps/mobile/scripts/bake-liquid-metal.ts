/**
 * Bakes assets/brand/kortix-liquid-metal.png, the texture the dither logo
 * style samples (its alpha plane; the file kept its name from the liquid-metal
 * style that originally baked it and was removed 2026-09-22). Run:
 * `bun scripts/bake-liquid-metal.ts` (or `pnpm bake:liquid-metal`).
 *
 * Same steps as Paper's `toProcessedLiquidMetal`: the symbol's alpha at the
 * working size (shorter side 512 px), the Poisson edge field solved there,
 * upscaled with a smooth kernel to the plane size, and the symbol's own alpha
 * rasterised at the plane size. Written as two gray planes side by side,
 * edge | alpha (see `packPlanes` for why). The plane is the symbol's tight
 * bounding box (the SVG viewBox, 30 x 25), because the shader's stripe maths
 * reads `uv` as [0,1] across exactly that box.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

import {
  bakeEdgeField,
  packPlanes,
  shapeMaskFromAlpha,
  workingSize,
} from '../lib/effects/liquid-metal-bake';

/** Plane size: the symbol's 30 x 25 box. At 3x a 150pt symbol is 450 px wide. */
const PLANE_WIDTH = 720;
const PLANE_HEIGHT = 600;

const root = path.join(import.meta.dir, '..');
const svgPath = path.join(root, 'assets/brand/kortix-symbol.svg');
const outPath = path.join(root, 'assets/brand/kortix-liquid-metal.png');
const svg = readFileSync(svgPath);

async function alphaAt(width: number, height: number): Promise<Uint8ClampedArray> {
  const { data } = await sharp(svg, { density: 600 })
    .resize(width, height, { fit: 'fill' })
    .ensureAlpha()
    .extractChannel('alpha')
    .raw()
    .toBuffer({ resolveWithObject: true });
  return new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength);
}

const working = workingSize(PLANE_WIDTH, PLANE_HEIGHT);
const workingAlpha = await alphaAt(working.width, working.height);
const edgeWorking = bakeEdgeField(shapeMaskFromAlpha(workingAlpha), working.width, working.height);

const edge = await sharp(Buffer.from(edgeWorking.buffer), {
  raw: { width: working.width, height: working.height, channels: 1 },
})
  .resize(PLANE_WIDTH, PLANE_HEIGHT, { kernel: 'lanczos3', fit: 'fill' })
  // sharp widens a 1-channel raw image to 3 channels when it resizes.
  .toColourspace('b-w')
  .raw()
  .toBuffer({ resolveWithObject: true });
if (edge.info.channels !== 1) throw new Error(`expected a 1-channel edge plane, got ${edge.info.channels}`);

const alpha = await alphaAt(PLANE_WIDTH, PLANE_HEIGHT);
const atlas = packPlanes([new Uint8ClampedArray(edge.data), alpha], PLANE_WIDTH, PLANE_HEIGHT);
const png = await sharp(Buffer.from(atlas.buffer), {
  raw: { width: PLANE_WIDTH * 2, height: PLANE_HEIGHT, channels: 1 },
})
  .png({ compressionLevel: 9 })
  .toBuffer();
writeFileSync(outPath, png);
console.log(
  `wrote ${path.relative(root, outPath)}: ${PLANE_WIDTH * 2}x${PLANE_HEIGHT} gray (edge | alpha), field solved at ${working.width}x${working.height}, ${png.length} bytes`,
);
