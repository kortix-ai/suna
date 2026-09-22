/**
 * Renders DITHERING_SKSL offline with CanvasKit (software raster) to PNG
 * files, so the look can be checked without a device. The heatmap has its own
 * script, `render-sksl.ts`.
 * Run: `bun scripts/render-dither-sksl.ts <outDir> [size]`.
 * TONE=light draws the light-page colours on white; the default is dark on
 * black. One file per (time, angle) case: the rest frame, then the frames a
 * full tilt reaches.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import CanvasKitInit from 'canvaskit-wasm';

import {
  DITHERING_PARAMS as D,
  DITHERING_REST_TIME,
  DITHERING_SKSL,
  DITHERING_SWEEP_SECONDS,
} from '../lib/effects/dithering-sksl';
import { LOGO_STYLE_COLORS } from '../lib/effects/logo-style';

const outDir = process.argv[2] ?? '.';
const size = Number(process.argv[3] ?? 150);
const tone = process.env.TONE === 'light' ? 'light' : 'dark';
const pixelRatio = Number(process.env.PIXEL_RATIO ?? 3);

const CanvasKit = await CanvasKitInit();
const effect = CanvasKit.RuntimeEffect.Make(DITHERING_SKSL, (e) => {
  throw new Error(e);
})!;

const tex = CanvasKit.MakeImageFromEncoded(
  readFileSync(path.join(import.meta.dir, '../assets/brand/kortix-liquid-metal.png')),
)!;
const imageShader = tex.makeShaderOptions(
  CanvasKit.TileMode.Clamp,
  CanvasKit.TileMode.Clamp,
  CanvasKit.FilterMode.Linear,
  CanvasKit.MipmapMode.None,
);

// The symbol's 30 x 25 box inside the square canvas, as MetalKortixLogo lays it out.
const box = [0, (size - size / 1.2) / 2, size, size / 1.2];

const cases: [string, number, number][] = [
  ['rest', DITHERING_REST_TIME, 0],
  ['sweep0.25', DITHERING_REST_TIME + 0.25 * DITHERING_SWEEP_SECONDS, 0],
  ['sweep0.5', DITHERING_REST_TIME + 0.5 * DITHERING_SWEEP_SECONDS, 0],
  ['sweep1', DITHERING_REST_TIME + DITHERING_SWEEP_SECONDS, 0],
  ['sweep1-angle90', DITHERING_REST_TIME + DITHERING_SWEEP_SECONDS, 90],
  ['sweep1-angle-120', DITHERING_REST_TIME + DITHERING_SWEEP_SECONDS, -120],
];

const front = LOGO_STYLE_COLORS[tone].dither.front;
for (const [name, time, angle] of cases) {
  // Declaration order of the uniforms in DITHERING_SKSL (CanvasKit takes a flat list).
  const uniforms = [
    tex.width(), tex.height(), // u_imageSize
    ...box, // u_imageBox
    size, size, // u_resolution
    time, // u_time
    D.scale, D.rotation + angle, D.size, // u_scale, u_rotation, u_pxSize
    0, 0, 0, 0, // u_colorBack
    ...front, // u_colorFront
    D.shape, D.type,
  ];
  const surface = CanvasKit.MakeSurface(size * pixelRatio, size * pixelRatio)!;
  const canvas = surface.getCanvas();
  canvas.clear(tone === 'light' ? CanvasKit.WHITE : CanvasKit.BLACK);
  canvas.scale(pixelRatio, pixelRatio);
  const shader = effect.makeShaderWithChildren(uniforms, [imageShader]);
  const paint = new CanvasKit.Paint();
  paint.setShader(shader);
  canvas.drawRect(CanvasKit.XYWHRect(0, 0, size, size), paint);
  const png = surface.makeImageSnapshot().encodeToBytes(CanvasKit.ImageFormat.PNG)!;
  const file = `dither-${tone}-${name}.png`;
  writeFileSync(path.join(outDir, file), png);
  console.log(`wrote ${file} (time ${time.toFixed(2)}, angle ${angle})`);
}
