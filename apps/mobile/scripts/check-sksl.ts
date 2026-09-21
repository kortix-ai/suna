/**
 * Compiles HEATMAP_SKSL with CanvasKit's SkSL compiler, so a porting mistake
 * shows up here and not on a device. Run: `bun scripts/check-sksl.ts`.
 * CanvasKit is the same Skia core that `@shopify/react-native-skia` ships, so
 * a compile error here is a compile error on the phone.
 */
import CanvasKitInit from 'canvaskit-wasm';

import { HEATMAP_SKSL } from '../lib/effects/heatmap-sksl';

const CanvasKit = await CanvasKitInit();
let error = '';
const effect = CanvasKit.RuntimeEffect.Make(HEATMAP_SKSL, (e) => {
  error = e;
});
if (!effect) {
  console.error(`SkSL compile FAILED:\n${error}`);
  process.exit(1);
}
console.log(`SkSL OK, uniforms: ${effect.getUniformCount()}`);
