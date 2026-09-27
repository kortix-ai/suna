/**
 * Renders HEATMAP_SKSL offline with CanvasKit (software raster) to PNG files, so
 * the look can be checked against Paper without a device.
 * Run: `bun scripts/render-sksl.ts <outDir> [size]`. One file per time/angle.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import CanvasKitInit from 'canvaskit-wasm';

import {
  HEATMAP_REST_TIME,
  HEATMAP_SKSL,
  HEATMAP_SWEEP_SECONDS,
  PAPER_HEATMAP_PARAMS as P,
} from '../lib/effects/heatmap-sksl';

const outDir = process.argv[2] ?? '.';
const prefix = process.env.TONE === 'light' ? `light-${process.env.LIGHT ?? 'soft'}-` : '';
const size = Number(process.argv[3] ?? 440);
// TONE=light draws the light-theme palette on white; the default is dark on black.
const light = process.env.TONE === 'light';
// LIGHT=<name> picks a light-theme candidate palette to compare.
const LIGHT: Record<string, { first: number[]; second: number[] }> = {
  soft: { first: [0.141, 0.141, 0.141, 1], second: [0.9, 0.9, 0.9, 1] },
};
const palette = light
  ? (LIGHT[process.env.LIGHT ?? 'soft'] ?? LIGHT.soft!)
  : { first: [1, 1, 1, 1], second: [0.141, 0.141, 0.141, 1] };
const CanvasKit = await CanvasKitInit();
const effect = CanvasKit.RuntimeEffect.Make(HEATMAP_SKSL, (e) => {
  throw new Error(e);
})!;

const tex = CanvasKit.MakeImageFromEncoded(readFileSync(path.join(import.meta.dir, '../assets/brand/kortix-heatmap.png')))!;
const imageShader = tex.makeShaderOptions(
  CanvasKit.TileMode.Clamp,
  CanvasKit.TileMode.Clamp,
  CanvasKit.FilterMode.Linear,
  CanvasKit.MipmapMode.None,
);

// SWEEP=1 renders the frames a move can reach: the rest frame plus
// 0..HEATMAP_SWEEP_SECONDS of shader time, at the rest angle. Default: a spread
// of unrelated frames.
const cases: [string, number, number][] = process.env.SWEEP
  ? [0, 0.2, 0.4, 0.6, 0.8, 1].map((k): [string, number, number] => [
      `sweep${k}`,
      HEATMAP_REST_TIME + k * HEATMAP_SWEEP_SECONDS,
      P.angle,
    ])
  : [
      ['paper-frame', HEATMAP_REST_TIME, P.angle],
      ['t0', 0, P.angle],
      ['t1', 2.5, P.angle],
      ['t2', 5, P.angle],
      ['t3', 7.5, P.angle],
      ['angle0', HEATMAP_REST_TIME, 0],
      ['angle120', HEATMAP_REST_TIME, 120],
      ['angle-120', HEATMAP_REST_TIME, -120],
    ];

for (const [name, time, angle] of cases) {
  const surface = CanvasKit.MakeSurface(size, size)!;
  const canvas = surface.getCanvas();
  canvas.clear(light ? CanvasKit.WHITE : CanvasKit.BLACK);
  const shader = effect.makeShaderWithChildren(
    // Declaration order of the uniforms in HEATMAP_SKSL. PALETTE is set below.
    [
      size, size, // u_resolution
      tex.width(), tex.height(), // u_imageSize
      time, // u_time
      P.scale, // u_scale
      ...palette.first, ...palette.second, // u_color0, u_color1
      0, 0, 0, 0, // u_colorBack, transparent
      angle, P.noise, P.innerGlow, P.outerGlow, P.contour,
    ],
    [imageShader],
  );
  const paint = new CanvasKit.Paint();
  paint.setShader(shader);
  canvas.drawRect(CanvasKit.XYWHRect(0, 0, size, size), paint);
  const png = surface.makeImageSnapshot().encodeToBytes(CanvasKit.ImageFormat.PNG)!;
  writeFileSync(path.join(outDir, `${prefix}${name}.png`), png);
  console.log(`wrote ${name}.png (time ${time.toFixed(2)}, angle ${angle})`);
}
