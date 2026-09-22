/**
 * Compiles every logo shader (HEATMAP_SKSL, DITHERING_SKSL) with CanvasKit's
 * SkSL compiler, so a porting mistake shows up here and not on a device.
 * Run: `bun scripts/check-sksl.ts`.
 * CanvasKit is the same Skia core that `@shopify/react-native-skia` ships, so
 * a compile error here is a compile error on the phone.
 */
import CanvasKitInit from 'canvaskit-wasm';

import { DITHERING_SKSL } from '../lib/effects/dithering-sksl';
import { HEATMAP_SKSL } from '../lib/effects/heatmap-sksl';

const CanvasKit = await CanvasKitInit();
let failed = false;
for (const [name, source] of [
  ['HEATMAP_SKSL', HEATMAP_SKSL],
  ['DITHERING_SKSL', DITHERING_SKSL],
] as const) {
  let error = '';
  const effect = CanvasKit.RuntimeEffect.Make(source, (e) => {
    error = e;
  });
  if (!effect) {
    console.error(`${name}: SkSL compile FAILED:\n${error}`);
    failed = true;
    continue;
  }
  console.log(`${name}: SkSL OK, uniforms: ${effect.getUniformCount()}`);
}
if (failed) process.exit(1);
