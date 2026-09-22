# Metallic Kortix Logo With Tilt (Paper Heatmap Shader) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat Kortix symbol on the mobile project home with a metallic, shiny symbol rendered by a port of Paper's `Heatmap` shader. Tilting the phone in any direction moves the highlight. iOS and Android.

**Architecture:** `@paper-design/shaders-react` is WebGL-only and cannot run in React Native. The Heatmap fragment shader is ported to SkSL and run through `@shopify/react-native-skia` (already installed, 2.6.9). The shader reads a pre-baked 3-channel PNG (the web library computes it at runtime from the SVG with a canvas blur; we bake it once at build time from `assets/brand/kortix-symbol.svg`). Tilt comes from Reanimated's `useAnimatedSensor(SensorType.ROTATION)`, which runs on the UI thread and needs no new native module.

**Tech Stack:** `@shopify/react-native-skia` 2.6.9 (`Skia.RuntimeEffect`), `react-native-reanimated` 4.3.1 (`useAnimatedSensor`, `useFrameCallback`), `sharp` (bake script only, devDependency, not shipped), `bun test` for pure logic.

**Spec:** Jay's message of 2026-09-21 plus the Paper snippet (below). No separate spec file.

Paper snippet, verbatim parameters:
`Heatmap speed=0.64 contour=1 angle=51 noise=0 innerGlow=0.89 outerGlow=0 scale=0.9 colors=['#FFFFFF','#242424'] colorBack='#00000000' frame=643565.019999678`, container 220x182, `backgroundColor #000000`.

## Global Constraints

- Platforms: iOS and Android. No platform-specific shader code.
- No new native dependency. `expo-sensors` is NOT added (an install would need a new dev-client build and a manual `patch-package` + install-skia step per `suna-mobile-sdk56-upgrade`).
- `ProjectHero` keeps its public behavior: resting size `heroLogoSize(width)`, keyboard scale `HERO_KEYBOARD_SCALE`, `accessibilityRole="image"`, `accessibilityLabel="Kortix"`.
- `bun test` cannot load native modules. Tests cover pure functions only. Shader and sensor behavior is verified in the iOS Simulator and on a physical Android device.
- Reduce Motion ON: no tilt, no idle drift. Render one still frame.
- No new colors outside the two Paper hex values plus the light-theme pair chosen in Decision 1. Follow `apps/mobile/design.md`.
- No commits until Jay asks (standing rule). The "Commit" steps below are checkpoints for Jay to approve, not automatic.
- No Linear IDs, no "Claude" in code, comments, or PR text.

## Decisions to confirm before Task 4 (recommendation first)

1. **Light theme palette.** Paper's design is white-on-black. Recommendation: dark theme uses Paper's exact `['#FFFFFF','#242424']` on transparent; light theme uses the inverse mapping `['#242424','#FFFFFF']`-style ramp on a transparent background so the symbol reads as dark chrome. Alternative: force a black tile behind the hero in light theme (rejected: adds a one-off box, violates design.md).
2. **Tilt mapping.** Recommendation: tilt direction sets the shader `u_angle`, tilt magnitude sweeps the highlight (`u_time` offset). A slow idle drift (`speed 0.64`) keeps it alive at rest. Alternative: tilt only, no idle drift (rejected: static logo when the phone lies flat on a table).
3. **Where it shows.** Recommendation: everywhere `ProjectHero` renders (project home, and a new empty chat). Say if only project home is wanted.

## File Structure

| Path | Action | Responsibility |
|---|---|---|
| `apps/mobile/lib/effects/heat-tilt.ts` | Create | Pure: tilt (pitch, roll) → `{ angleDeg, sweep }`, low-pass smoothing, dead zone. |
| `apps/mobile/lib/effects/heat-tilt.test.ts` | Create | `bun test` for the above. |
| `apps/mobile/lib/effects/heatmap-bake.ts` | Create | Pure: `blurGray`, `multiPassBlurGray`, `packHeatmap` (port of Paper `toProcessedHeatmap`). |
| `apps/mobile/lib/effects/heatmap-bake.test.ts` | Create | `bun test` for the bake maths on a tiny synthetic image. |
| `apps/mobile/scripts/bake-heatmap.ts` | Create | Rasterize the SVG with `sharp`, run `heatmap-bake`, write the PNG. |
| `apps/mobile/assets/brand/kortix-heatmap.png` | Create (generated) | Baked texture. R=contour, G=big blur, B=inner blur, A=255. |
| `apps/mobile/lib/effects/heatmap-sksl.ts` | Create | The SkSL source string and its uniform list. |
| `apps/mobile/components/kortix/MetalKortixLogo.tsx` | Create | Skia canvas, shader, sensor, frame loop, fallback. |
| `apps/mobile/components/session/ProjectHero.tsx` | Modify | Render `MetalKortixLogo` instead of `KortixLogo`. |
| `apps/mobile/design.md` | Modify | Document the hero effect and its Reduce Motion rule. |
| `apps/mobile/package.json` | Modify | Add `sharp` devDependency and a `bake:heatmap` script. |

---

### Task 1: Tilt maths (pure)

**Files:**
- Create: `apps/mobile/lib/effects/heat-tilt.ts`
- Test: `apps/mobile/lib/effects/heat-tilt.test.ts`

**Interfaces:**
- Produces:
  - `export const TILT_DEAD_ZONE_RAD = 0.02`
  - `export const TILT_FULL_RAD = 0.6` (about 34 degrees = full sweep)
  - `export function tiltToHeat(pitch: number, roll: number): { angleDeg: number; sweep: number }` — `sweep` in `[0, 1]`.
  - `export function smooth(prev: number, next: number, dtSec: number, tauSec: number): number`
  - `export function shortestAngleDelta(fromDeg: number, toDeg: number): number` — result in `(-180, 180]`, so the angle never spins the long way round when the phone crosses the 180 degree line.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from 'bun:test';
import { shortestAngleDelta, smooth, tiltToHeat, TILT_DEAD_ZONE_RAD, TILT_FULL_RAD } from './heat-tilt';

describe('tiltToHeat', () => {
  test('flat phone: sweep 0', () => {
    expect(tiltToHeat(0, 0).sweep).toBe(0);
  });
  test('inside the dead zone: sweep 0', () => {
    expect(tiltToHeat(TILT_DEAD_ZONE_RAD / 2, 0).sweep).toBe(0);
  });
  test('full tilt: sweep 1, clamped beyond', () => {
    expect(tiltToHeat(TILT_FULL_RAD, 0).sweep).toBeCloseTo(1, 5);
    expect(tiltToHeat(3, 3).sweep).toBe(1);
  });
  test('direction: roll right = 0 deg, pitch forward = 90 deg', () => {
    expect(tiltToHeat(0, 0.3).angleDeg).toBeCloseTo(0, 5);
    expect(tiltToHeat(0.3, 0).angleDeg).toBeCloseTo(90, 5);
  });
});

describe('shortestAngleDelta', () => {
  test('wraps across 180', () => {
    expect(shortestAngleDelta(170, -170)).toBeCloseTo(20, 5);
    expect(shortestAngleDelta(-170, 170)).toBeCloseTo(-20, 5);
  });
});

describe('smooth', () => {
  test('dt 0 keeps prev', () => expect(smooth(1, 5, 0, 0.1)).toBe(1));
  test('large dt reaches next', () => expect(smooth(1, 5, 10, 0.1)).toBeCloseTo(5, 3));
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd apps/mobile && bun test lib/effects/heat-tilt.test.ts`
Expected: FAIL, `Cannot find module './heat-tilt'`.

- [ ] **Step 3: Implement**

```ts
/**
 * heat-tilt — turns device tilt into the two inputs the metallic-logo shader
 * needs: a direction (`angleDeg`) and how far the highlight has swept (`sweep`).
 *
 * Pure functions only: `bun test` cannot load native modules.
 */

export const TILT_DEAD_ZONE_RAD = 0.02;
export const TILT_FULL_RAD = 0.6;

export function tiltToHeat(pitch: number, roll: number): { angleDeg: number; sweep: number } {
  const magnitude = Math.hypot(pitch, roll);
  if (magnitude <= TILT_DEAD_ZONE_RAD) return { angleDeg: 0, sweep: 0 };
  const sweep = Math.min(1, (magnitude - TILT_DEAD_ZONE_RAD) / (TILT_FULL_RAD - TILT_DEAD_ZONE_RAD));
  const angleDeg = (Math.atan2(pitch, roll) * 180) / Math.PI;
  return { angleDeg, sweep };
}

export function shortestAngleDelta(fromDeg: number, toDeg: number): number {
  let d = (toDeg - fromDeg) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

/** Exponential low-pass: frame-rate independent. `tauSec` is the time constant. */
export function smooth(prev: number, next: number, dtSec: number, tauSec: number): number {
  if (dtSec <= 0) return prev;
  const k = 1 - Math.exp(-dtSec / tauSec);
  return prev + (next - prev) * k;
}
```

Note: `'worklet'` directives are added in Task 4 where these functions are called from the UI thread (Step 2 there).

- [ ] **Step 4: Run and confirm it passes**

Run: `cd apps/mobile && bun test lib/effects/heat-tilt.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Checkpoint (Jay approves before any commit)**

```bash
git add apps/mobile/lib/effects/heat-tilt.ts apps/mobile/lib/effects/heat-tilt.test.ts
git commit -m "feat(mobile): tilt-to-highlight maths for the metallic hero"
```

---

### Task 2: Bake the heat texture (build-time)

Reason: Paper's shader samples `u_image`, a texture the web library builds at runtime with `document.createElement('canvas')` (`toProcessedHeatmap`, `@paper-design/shaders@0.0.76 dist/shaders/heatmap.js:262`). React Native has no such canvas. The result is deterministic per SVG, so it is baked once into a PNG.

**Files:**
- Create: `apps/mobile/lib/effects/heatmap-bake.ts`, `apps/mobile/lib/effects/heatmap-bake.test.ts`, `apps/mobile/scripts/bake-heatmap.ts`
- Modify: `apps/mobile/package.json` (`sharp` devDependency, script `"bake:heatmap": "bun scripts/bake-heatmap.ts"`)
- Generate: `apps/mobile/assets/brand/kortix-heatmap.png`

**Interfaces:**
- Produces:
  - `export function blurGray(gray: Uint8ClampedArray, w: number, h: number, radius: number): Uint8ClampedArray` (box blur via integral image, identical to Paper's)
  - `export function multiPassBlurGray(gray, w, h, radius, passes): Uint8ClampedArray`
  - `export function packHeatmap(gray: Uint8ClampedArray, w: number, h: number, canvasSize: number): Uint8ClampedArray` — RGBA. `maxBlur = floor(canvasSize*0.15)`, `bigBlur = maxBlur` x3 passes into G, `innerBlur = max(1, round(0.12*maxBlur))` x3 passes into B, `contour radius 5` x1 pass into R, A = 255.
  - Constants: `CANVAS_SIZE = 1000`, `PADDING = ceil(floor(1000*0.15)*2.5) = 375`.

- [ ] **Step 1: Write the failing test** (tiny 8x8 image so the expected numbers are hand-checkable)

```ts
import { describe, expect, test } from 'bun:test';
import { blurGray, packHeatmap } from './heatmap-bake';

describe('blurGray', () => {
  test('radius 0 returns a copy', () => {
    const g = new Uint8ClampedArray([0, 255, 0, 255]);
    const out = blurGray(g, 2, 2, 0);
    expect(Array.from(out)).toEqual([0, 255, 0, 255]);
    expect(out).not.toBe(g);
  });
  test('uniform image stays uniform', () => {
    const g = new Uint8ClampedArray(25).fill(200);
    expect(Array.from(blurGray(g, 5, 5, 2)).every((v) => v === 200)).toBe(true);
  });
  test('single white pixel spreads to its 3x3 neighbourhood at radius 1', () => {
    const g = new Uint8ClampedArray(25);
    g[12] = 255;
    const out = blurGray(g, 5, 5, 1);
    expect(out[12]).toBe(Math.round(255 / 9));
    expect(out[0]).toBe(0);
  });
});

describe('packHeatmap', () => {
  test('alpha is 255 everywhere and channel order is R contour, G big, B inner', () => {
    const g = new Uint8ClampedArray(16 * 16).fill(255);
    g[8 * 16 + 8] = 0;
    const px = packHeatmap(g, 16, 16, 100);
    expect(px.length).toBe(16 * 16 * 4);
    expect(px[3]).toBe(255);
    const i = (8 * 16 + 8) * 4;
    expect(px[i]).toBeLessThan(255); // contour reacts to the dark pixel
  });
});
```

- [ ] **Step 2: Run and confirm FAIL**

Run: `cd apps/mobile && bun test lib/effects/heatmap-bake.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `heatmap-bake.ts`** by porting `blurGray`, `multiPassBlurGray` and the channel packing loop from `node_modules/.pnpm/@paper-design+shaders@0.0.76/node_modules/@paper-design/shaders/dist/shaders/heatmap.js` lines 300-385, adding TS types. Do not change the algorithm: the shader constants (`8.` blur radius, `.03` frame) were tuned against exactly this texture.

```ts
export const CANVAS_SIZE = 1000;
const MAX_BLUR = Math.floor(CANVAS_SIZE * 0.15);
export const PADDING = Math.ceil(MAX_BLUR * 2.5);

export function blurGray(gray: Uint8ClampedArray, width: number, height: number, radius: number): Uint8ClampedArray {
  if (radius <= 0) return gray.slice();
  const out = new Uint8ClampedArray(width * height);
  const integral = new Uint32Array(width * height);
  for (let y = 0; y < height; y++) {
    let rowSum = 0;
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      rowSum += gray[idx] ?? 0;
      integral[idx] = rowSum + (y > 0 ? (integral[idx - width] ?? 0) : 0);
    }
  }
  for (let y = 0; y < height; y++) {
    const y1 = Math.max(0, y - radius);
    const y2 = Math.min(height - 1, y + radius);
    for (let x = 0; x < width; x++) {
      const x1 = Math.max(0, x - radius);
      const x2 = Math.min(width - 1, x + radius);
      const A = integral[y2 * width + x2] ?? 0;
      const B = x1 > 0 ? (integral[y2 * width + (x1 - 1)] ?? 0) : 0;
      const C = y1 > 0 ? (integral[(y1 - 1) * width + x2] ?? 0) : 0;
      const D = x1 > 0 && y1 > 0 ? (integral[(y1 - 1) * width + (x1 - 1)] ?? 0) : 0;
      const area = (x2 - x1 + 1) * (y2 - y1 + 1);
      out[y * width + x] = Math.round((A - B - C + D) / area);
    }
  }
  return out;
}

export function multiPassBlurGray(
  gray: Uint8ClampedArray, width: number, height: number, radius: number, passes: number,
): Uint8ClampedArray {
  if (radius <= 0 || passes <= 1) return blurGray(gray, width, height, radius);
  let input = gray;
  for (let p = 0; p < passes; p++) input = blurGray(input, width, height, radius);
  return input;
}

/** RGBA: R = contour, G = big blur, B = inner blur, A = 255. */
export function packHeatmap(
  gray: Uint8ClampedArray, width: number, height: number, canvasSize: number,
): Uint8ClampedArray {
  const maxBlur = Math.floor(canvasSize * 0.15);
  const inner = Math.max(1, Math.round(0.12 * maxBlur));
  const big = multiPassBlurGray(gray, width, height, maxBlur, 3);
  const innerBlur = multiPassBlurGray(gray, width, height, inner, 3);
  const contour = multiPassBlurGray(gray, width, height, 5, 1);
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const p = i * 4;
    out[p] = contour[i] ?? 0;
    out[p + 1] = big[i] ?? 0;
    out[p + 2] = innerBlur[i] ?? 0;
    out[p + 3] = 255;
  }
  return out;
}
```

- [ ] **Step 4: Run and confirm PASS**

Run: `cd apps/mobile && bun test lib/effects/heatmap-bake.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Write `scripts/bake-heatmap.ts`**

Steps in the script (same as Paper's canvas path): rasterize `assets/brand/kortix-symbol.svg` (`sharp` with `density` set so the long side is 1000 px after fitting), composite on a white `1000 + 2*375` square (white fill, symbol black, symbol centered at `PADDING`), convert to gray with `0.299 R + 0.587 G + 0.114 B`, call `packHeatmap(gray, w, h, 1000)`, write `assets/brand/kortix-heatmap.png` (RGBA raw → PNG via `sharp(raw, { raw: { width, height, channels: 4 } }).png()`). Output size is 1750x1750 (`1000 + 2*375`). Check the PNG file size; target under 1.5 MB. If larger, keep quality and resize the whole texture to 875x875 and pass its size as a uniform (Task 3 already takes `u_imageSize`).

- [ ] **Step 6: Run the bake and inspect the output**

Run: `cd apps/mobile && pnpm add -D sharp && bun scripts/bake-heatmap.ts && file assets/brand/kortix-heatmap.png && ls -l assets/brand/kortix-heatmap.png`
Expected: `PNG image data, 1750 x 1750, 8-bit/color RGBA`, size printed. Open the PNG and confirm: white frame, soft dark halo around the symbol in G, sharp edge in R.

If `pnpm add` fails under the repo's ignore-scripts setting, run `pnpm rebuild sharp` (sharp ships prebuilt binaries; it needs the install script).

- [ ] **Step 7: Checkpoint**

```bash
git add apps/mobile/lib/effects/heatmap-bake.ts apps/mobile/lib/effects/heatmap-bake.test.ts apps/mobile/scripts/bake-heatmap.ts apps/mobile/assets/brand/kortix-heatmap.png apps/mobile/package.json pnpm-lock.yaml
git commit -m "feat(mobile): bake the heat texture for the metallic hero"
```

---

### Task 3: Port the shader to SkSL

Porting rules (GLSL ES 3.00 → SkSL). Each is a known incompatibility in Paper's source:

| Paper GLSL | SkSL |
|---|---|
| `#version 300 es`, `in`/`out`, `precision` | remove; entry point is `half4 main(float2 fragCoord)` |
| `uniform sampler2D u_image` | `uniform shader u_image;` sample with `u_image.eval(uv * u_imageSize)` (pixel coordinates, not 0..1) |
| `textureSize(tex,0)` | `uniform float2 u_imageSize` |
| `textureGrad`, `dFdx`, `dFdy` | not available. Use `.eval` (no mips are in play; the texture is 1750 px and drawn at about 200 px, so bilinear sampling alone can shimmer: enable `FilterMode.Linear` and `MipmapMode.Linear` on the image shader in Task 4) |
| `vec4 u_colors[10]`, `u_colorsCount`, loop with `break` | two fixed colors: `u_color0`, `u_color1` (`half4`); unroll: `outerShape = clamp(heat*2, 0, 1)`, `gradient = mix(c0, c1, clamp(heat*2 - 1, 0, 1))` |
| `v_imageUV`, `v_objectUV` | derive from `fragCoord / u_resolution`; `scale=0.9` is applied by centering and scaling `objectUV` before the image UV mapping |
| `mod`, `pow`, `smoothstep`, `fract`, `sin`, `dot`, `mix`, `clamp` | same names in SkSL (`mod` takes matching types, as here) |
| `float` | `float` (keep `highp` behavior; do not use `half` inside `shadowShape`) |

**Files:**
- Create: `apps/mobile/lib/effects/heatmap-sksl.ts`

**Interfaces:**
- Produces:
  - `export const HEATMAP_SKSL: string` (full source)
  - `export type HeatmapUniforms = { u_resolution: [number, number]; u_imageSize: [number, number]; u_time: number; u_angle: number; u_contour: number; u_innerGlow: number; u_outerGlow: number; u_noise: number; u_color0: [number, number, number, number]; u_color1: [number, number, number, number]; u_colorBack: [number, number, number, number]; }` — colors are premultiplied-free RGBA in 0..1, as Skia expects for `half4` uniforms.
  - `export const PAPER_HEATMAP_PARAMS = { speed: 0.64, contour: 1, angle: 51, noise: 0, innerGlow: 0.89, outerGlow: 0, scale: 0.9 } as const`

- [ ] **Step 1: Copy the body of `heatmapFragmentShader` from the installed package** (lines 8-260 of the file named in Task 2) into `HEATMAP_SKSL`, then apply the table above. Keep `getImgFrame`, `circle`, `lst`, `sst`, `shadowShape`, `blurEdge3x3` (rewritten with `.eval`), and the `main` body unchanged apart from the substitutions. Every constant in `shadowShape` stays byte-identical.

  `blurEdge3x3` becomes:

  ```glsl
  float blurEdge3x3(float2 uv, float radius, float centerSample) {
    float2 r = radius / u_imageSize;          // radius in texels, as in Paper
    float sum = 4.0 * centerSample;
    sum += 2.0 * u_image.eval((uv + float2(0.0, -r.y)) * u_imageSize).g;
    sum += 2.0 * u_image.eval((uv + float2(0.0,  r.y)) * u_imageSize).g;
    sum += 2.0 * u_image.eval((uv + float2(-r.x, 0.0)) * u_imageSize).g;
    sum += 2.0 * u_image.eval((uv + float2( r.x, 0.0)) * u_imageSize).g;
    sum += u_image.eval((uv + float2(-r.x, -r.y)) * u_imageSize).g;
    sum += u_image.eval((uv + float2( r.x, -r.y)) * u_imageSize).g;
    sum += u_image.eval((uv + float2(-r.x,  r.y)) * u_imageSize).g;
    sum += u_image.eval((uv + float2( r.x,  r.y)) * u_imageSize).g;
    return sum / 16.0;
  }
  ```

  The image UV mapping in `main` keeps Paper's `imgUV = (v_imageUV - .5) * 0.5714285714285714 + .5` (that constant is `1/1.75`: the padded texture is 1.75x the symbol box). With `scale=0.9`, `v_imageUV` is `(fragCoord/u_resolution - .5) / 0.9 + .5`.

- [ ] **Step 2: Compile check that runs without a device**

`bun test` cannot load Skia. Add a Node-side compile check using the same SkSL compiler Skia ships for the web: `canvaskit-wasm` (devDependency, script only) `MakeRuntimeEffect(HEATMAP_SKSL)`. Create `apps/mobile/scripts/check-sksl.ts` that imports `HEATMAP_SKSL`, calls `CanvasKit.RuntimeEffect.Make(HEATMAP_SKSL, (err) => { throw new Error(err) })`, and prints the uniform count.

Run: `cd apps/mobile && pnpm add -D canvaskit-wasm && bun scripts/check-sksl.ts`
Expected: prints `SkSL OK, uniforms: <n>`. Any compile error prints the SkSL line. Fix until clean. (This catches the porting mistakes in the table above in seconds instead of on a device.)

- [ ] **Step 3: Checkpoint**

```bash
git add apps/mobile/lib/effects/heatmap-sksl.ts apps/mobile/scripts/check-sksl.ts apps/mobile/package.json pnpm-lock.yaml
git commit -m "feat(mobile): SkSL port of the Paper heatmap shader"
```

---

### Task 4: `MetalKortixLogo` component

**Files:**
- Create: `apps/mobile/components/kortix/MetalKortixLogo.tsx`
- Modify: `apps/mobile/lib/effects/heat-tilt.ts` (add `'worklet'` to the three functions)

**Interfaces:**
- Consumes: `HEATMAP_SKSL`, `PAPER_HEATMAP_PARAMS`, `HeatmapUniforms` (Task 3); `tiltToHeat`, `smooth`, `shortestAngleDelta` (Task 1); `assets/brand/kortix-heatmap.png` (Task 2).
- Produces: `export function MetalKortixLogo(props: { size: number; tone: 'light' | 'dark' }): JSX.Element`. `size` is the symbol's height in points (same meaning as `KortixLogo.size`). The canvas is `size * 1.75 * 0.9` wide and high so the glow has room, and is positioned with negative margin so layout size equals the symbol box.

Behavior:

- Load the PNG with `useImage(require('@/assets/brand/kortix-heatmap.png'))`. While it is `null`, render `KortixLogo` (flat). No layout shift: both use the same outer box.
- Build the effect once: `Skia.RuntimeEffect.Make(HEATMAP_SKSL)`. If it returns `null` (compile failure on a device driver), render `KortixLogo` and `console.warn` once in `__DEV__`.
- Sensor: `const rotation = useAnimatedSensor(SensorType.ROTATION, { interval: 'auto' })`. Read `rotation.sensor.value.pitch` and `.roll`. If `rotation.sensor.value` never updates (Android device without a rotation sensor, or Simulator), the shader shows the idle drift only. That is the intended fallback.
- One frame loop, UI thread: `useFrameCallback((f) => { … })` updates three shared values: `idleTime += dt * speed`, `angle` (smoothed via `shortestAngleDelta`, tau 0.12 s), `sweep` (smoothed, tau 0.10 s). `u_time = idleTime + sweep * SWEEP_SECONDS` where `SWEEP_SECONDS = 4` (one tilt from flat to full moves the highlight through 40 percent of a cycle; tune in Step 5). `u_angle = PAPER_HEATMAP_PARAMS.angle + angle`.
- Uniforms are a `useDerivedValue` returning the `HeatmapUniforms` object; the canvas draws `<Fill><Shader source={effect} uniforms={uniforms}><ImageShader image={image} fit="fill" rect={...} /></Shader></Fill>`.
- Reduce Motion (`AccessibilityInfo.isReduceMotionEnabled` + change listener, same pattern as `components/animations/kortix-currents.tsx`): `frameCallback.setActive(false)`, freeze `u_time` at the Paper snapshot value (`643565.02 ms * 0.001 * 0.64 = 411.88`; verify this equation against `@paper-design/shaders-react` `ShaderMount` source before relying on it, see Step 4), draw one frame.
- Pause the loop when the app is not `active` (`AppState`) and when the screen is not focused (`useIsFocused` from `expo-router`/react-navigation), so the sensor and GPU stop off-screen.
- Palette (Decision 1): `dark` → `u_color0 #FFFFFF`, `u_color1 #242424`, `u_colorBack #00000000`. `light` → chosen pair, `u_colorBack #00000000`.
- Haptics: none. (Not requested. YAGNI.)

- [ ] **Step 1: Add `'worklet'`** as the first statement in `tiltToHeat`, `shortestAngleDelta`, `smooth`. Re-run `bun test lib/effects/heat-tilt.test.ts`. Expected: PASS (a directive string is a no-op in bun).

- [ ] **Step 2: Write the component** using the behavior list above. Follow the file-header comment style of `ProjectHero.tsx` and `kortix-currents.tsx` (say what it does, and the non-obvious why). Do not import `KortixLogo` circularly: `MetalKortixLogo` imports `KortixLogo`, `ProjectHero` imports `MetalKortixLogo`.

- [ ] **Step 3: Type and lint gate**

Run: `cd apps/mobile && npx tsc --noEmit 2>&1 | tail -20` and `npx eslint components/kortix/MetalKortixLogo.tsx lib/effects`
Expected: no new errors vs the 5-error baseline (memory: `suna-mobile-tsc-undeclared-name-gate`). A `TS2304` means a Hermes `ReferenceError` at runtime; fix before moving on.

- [ ] **Step 4: Confirm the Paper frame equation**

Run: `grep -n "frame\|speed\|u_time" node_modules/.pnpm/@paper-design+shaders@0.0.76/node_modules/@paper-design/shaders/dist/shader-mount.js | head -30`
Expected: shows how `frame` (ms) and `speed` become `u_time`. If the equation differs from `frame * 0.001 * speed`, correct the frozen value in the component. The frozen frame must match Paper's canvas or the still image will not equal the design.

- [ ] **Step 5: Checkpoint**

```bash
git add apps/mobile/components/kortix/MetalKortixLogo.tsx apps/mobile/lib/effects/heat-tilt.ts
git commit -m "feat(mobile): metallic Kortix logo driven by device tilt"
```

---

### Task 5: Wire into `ProjectHero`, document, verify

**Files:**
- Modify: `apps/mobile/components/session/ProjectHero.tsx`
- Modify: `apps/mobile/design.md` (hero section; state the Reduce Motion rule and that tilt has no fallback control)

**Interfaces:**
- Consumes: `MetalKortixLogo` (Task 4).

- [ ] **Step 1: Swap the child.** In `ProjectHero.tsx` replace

```tsx
<KortixLogo size={heroLogoSize(width)} color={colorScheme === 'dark' ? 'dark' : 'light'} />
```

with

```tsx
<MetalKortixLogo size={heroLogoSize(width)} tone={colorScheme === 'dark' ? 'dark' : 'light'} />
```

Keep the `Reanimated.View` scale wrapper, the accessibility props, and the header comment (add one line: the symbol is the metallic shader effect and falls back to the flat symbol).

- [ ] **Step 2: Run the existing pure tests**

Run: `cd apps/mobile && bun test lib/session/project-hero.test.ts lib/effects`
Expected: PASS.

- [ ] **Step 3: iOS Simulator visual check (no tilt hardware)**

Follow the recipe in memory `suna-mobile-sim-visual-verify-recipe` (temp route under `app/share`, `simctl openurl`, `simctl screenshot`). Assert by screenshot: the symbol shows a metallic gradient in dark theme, transparent background (no black box), correct size (`heroLogoSize`), and it does not clip at the canvas edge. Compare against a Paper render of the snippet (`get_screenshot` on the Paper node, or the Paper URL in the snippet). Remove the temp route afterward.

- [ ] **Step 4: Tilt check on a physical device (required, the Simulator has no sensor)**

Build to a real iPhone and a real Android phone. Verify on each:

1. Phone flat: slow idle drift, no jitter.
2. Tilt left, right, toward, away, and diagonally: highlight moves in the tilt direction; no jump when crossing 180 degrees (the `shortestAngleDelta` case).
3. Rotate to landscape and back: no permanent offset (Reanimated compensates `interfaceOrientation`; confirm).
4. Settings > Accessibility > Reduce Motion ON: image freezes, no drift, no tilt response.
5. Background the app and return: loop resumes, no stuck highlight.
6. Open the keyboard: hero scales to `HERO_KEYBOARD_SCALE` and stays centered, effect keeps running.
7. Frame time: Xcode Instruments (iOS) or `adb shell dumpsys gfxinfo <pkg>` (Android). Target: no dropped frames on an iPhone 12-class and a mid-range Android. If frames drop, first lower canvas pixel density (`pixelRatio` prop), then shrink the baked texture to 875 px.

- [ ] **Step 5: Fallback check.** Temporarily make `Skia.RuntimeEffect.Make` return `null` (edit in a scratch build) and confirm the flat `KortixLogo` renders at the identical size and position. Revert the edit.

- [ ] **Step 6: Final gates, paste real output in the handoff**

Run: `cd apps/mobile && bun test lib/effects lib/session/project-hero.test.ts && npx tsc --noEmit 2>&1 | tail -5 && npx eslint components/kortix components/session/ProjectHero.tsx lib/effects`
Expected: tests pass; tsc at the 5-error baseline; eslint clean on touched files.

- [ ] **Step 7: Checkpoint**

```bash
git add apps/mobile/components/session/ProjectHero.tsx apps/mobile/design.md
git commit -m "feat(mobile): metallic tilt logo on the project home hero"
```

## Risks and unknowns (stated, not hidden)

1. **Shader fidelity.** The port drops `textureGrad`/`dFdx` and the 10-color loop. Expected visual difference is small; unverified until Task 5 Step 3. Owner: Task 3 + Task 5.
2. **Frame equation** for the frozen Reduce Motion frame is assumed. Verified in Task 4 Step 4.
3. **Sensor on Android.** `useAnimatedSensor` needs a hardware rotation vector sensor. Nearly all phones have one. Emulators do not report tilt (the Android emulator has virtual sensors in Extended Controls, usable for a smoke test).
4. **GPU cost.** Three `shadowShape` calls plus 9 texture reads per pixel, at about 210x210 pt. Believed fine. Measured only in Task 5 Step 4.
5. **PNG size** (about 1750 px) increases the app bundle by the PNG size. Measured in Task 2 Step 6, with a fallback to 875 px.
6. **Bake script depends on `sharp`.** Dev-only. If `sharp` cannot install, rasterize with Skia in a one-off Expo script instead.
7. **`sharp` and `canvaskit-wasm`** are new devDependencies. Confirm Jay accepts both.
8. **Delivery.** Per `CLAUDE.md`: branch is `revamp/mobile-ui`; no PR merge without Jay's word; no browser verification (web-only rule) so all visual proof is Simulator and device.

## Self-review

- Spec coverage: metallic look via Paper Heatmap (Tasks 2-4), tilt in any direction (Tasks 1, 4), iOS and Android (Global Constraints, Task 5 Step 4), project home logo (Task 5). Paper parameters are all mapped in `PAPER_HEATMAP_PARAMS`, `scale` in Task 3, `colors`/`colorBack` in Task 4, `frame` in Task 4.
- Placeholders: none. Task 4 Step 2 and Task 3 Step 1 delegate to named source lines and a substitution table instead of repeating 250 lines of shader text; the source file path and line range are given.
- Type names: `tiltToHeat`, `smooth`, `shortestAngleDelta`, `HeatmapUniforms`, `PAPER_HEATMAP_PARAMS`, `HEATMAP_SKSL`, `MetalKortixLogo` are used identically in all tasks.

## Outcome (built inline, 2026-09-21)

Tasks 1-5 are built and uncommitted on `revamp/mobile-ui`. Deviations from the plan above:

1. **Texture is three gray planes, not one RGB image** (Task 2). Skia color-manages an RGB texture; converting sRGB to the display's P3 mixed the channels, so the wide blur in G leaked into R (`shape` read about 0.97 where it must be 1) and drew a halo and a visible square around the symbol on the iOS simulator. The CPU render (CanvasKit) does not convert colors and never showed it. Fix: `splitPlanes` in `heatmap-bake.ts`, a 3000x1000 gray PNG (290 KB, was 885 KB), `samplePlane` in the shader. Offline render vs the RGB version: max diff 15/255, mean 0.18.
2. **Light palette is inverted** (Decision 1). The shader maps low heat to transparent, so on a white page Paper's white pair made the symbol vanish. Light uses near-black `first` over mid-gray `second`.
3. **Two extra dev scripts**: `scripts/render-sksl.ts` renders the shader to PNG through CanvasKit, `scripts/check-sksl.ts` compiles it. `canvaskit-wasm` and `sharp` are devDependencies.
4. **`shadowShape` clamp** is `clamp(s, 0., 1.)`. Paper's source has the arguments in the order `clamp(0., 1., s)`, which SkSL rejects.

Not verified: tilt response (the Simulator has no rotation sensor), Android, frame rate, light theme on a device (offline render only), Reduce Motion, landscape.
