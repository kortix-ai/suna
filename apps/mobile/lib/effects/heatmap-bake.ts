/**
 * heatmap-bake — builds the texture Paper's Heatmap shader samples.
 *
 * Port of `toProcessedHeatmap` from `@paper-design/shaders` 0.0.76
 * (`dist/shaders/heatmap.js`). Paper runs it in a browser canvas at load time;
 * React Native has no such canvas, and the result never changes for one SVG, so
 * `scripts/bake-heatmap.ts` runs it once and commits the PNG. The algorithm is
 * unchanged: the shader's constants were tuned against exactly this texture.
 *
 * Channels: R = contour (5px blur), G = big blur, B = inner blur, A = 255.
 *
 * Shipped as three gray planes side by side (`splitPlanes`), not as one RGB
 * image. The texture is data, not a picture, but Skia color-manages it like a
 * picture: converting sRGB to a wide-gamut display mixes the channels, so the
 * wide blur in G leaked into R and drew a halo around the symbol on a device
 * (measured on the iOS simulator: R read 0.97 where it is exactly 1). Neutral
 * gray passes through that conversion unchanged.
 *
 * Pure functions only: `bun test` cannot load native modules.
 */

export const CANVAS_SIZE = 1000;
const MAX_BLUR = Math.floor(CANVAS_SIZE * 0.15);
/** White margin around the symbol, so the big blur has room to fade out. */
export const PADDING = Math.ceil(MAX_BLUR * 2.5);

/** Box blur through an integral image. */
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
  gray: Uint8ClampedArray,
  width: number,
  height: number,
  radius: number,
  passes: number,
): Uint8ClampedArray {
  if (radius <= 0 || passes <= 1) return blurGray(gray, width, height, radius);
  let input = gray;
  for (let p = 0; p < passes; p++) input = blurGray(input, width, height, radius);
  return input;
}

/** RGBA pixels from a gray image (255 = background, 0 = symbol). */
export function packHeatmap(
  gray: Uint8ClampedArray,
  width: number,
  height: number,
  canvasSize: number,
): Uint8ClampedArray {
  const maxBlur = Math.floor(canvasSize * 0.15);
  const innerRadius = Math.max(1, Math.round(0.12 * maxBlur));
  const big = multiPassBlurGray(gray, width, height, maxBlur, 3);
  const inner = multiPassBlurGray(gray, width, height, innerRadius, 3);
  const contour = multiPassBlurGray(gray, width, height, 5, 1);
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const p = i * 4;
    out[p] = contour[i] ?? 0;
    out[p + 1] = big[i] ?? 0;
    out[p + 2] = inner[i] ?? 0;
    out[p + 3] = 255;
  }
  return out;
}

/** RGBA -> one gray image of three planes side by side: R | G | B. Alpha is dropped. */
export function splitPlanes(rgba: Uint8ClampedArray, width: number, height: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * 3 * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const src = (y * width + x) * 4;
      const row = y * width * 3;
      out[row + x] = rgba[src] ?? 0;
      out[row + width + x] = rgba[src + 1] ?? 0;
      out[row + 2 * width + x] = rgba[src + 2] ?? 0;
    }
  }
  return out;
}
