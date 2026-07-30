import { inflateSync } from 'node:zlib';

// Minimal, dependency-free PNG decoder for pixel-level assertions (e.g.
// measuring glyph slant from a screenshot). Node ships zlib, so the only
// non-trivial part is the PNG scanline filter reversal — no npm package
// needed. Supports exactly what Playwright's `locator.screenshot()` emits:
// 8-bit-depth, non-interlaced, colour type 6 (RGBA) or 2 (RGB).
export type DecodedPng = {
  width: number;
  height: number;
  // RGBA, 4 bytes per pixel, row-major, top-to-bottom.
  data: Uint8Array;
};

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

export function decodePng(buf: Buffer): DecodedPng {
  if (!buf.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error('decodePng: not a PNG (bad signature)');
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idatChunks: Buffer[] = [];

  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const data = buf.subarray(dataStart, dataStart + length);

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data.readUInt8(8);
      colorType = data.readUInt8(9);
      interlace = data.readUInt8(12);
    } else if (type === 'IDAT') {
      idatChunks.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
    offset = dataStart + length + 4; // skip CRC
  }

  if (bitDepth !== 8) {
    throw new Error(`decodePng: unsupported bitDepth ${bitDepth} (only 8 supported)`);
  }
  if (colorType !== 6 && colorType !== 2) {
    throw new Error(`decodePng: unsupported colorType ${colorType} (only RGB/RGBA supported)`);
  }
  if (interlace !== 0) {
    throw new Error('decodePng: interlaced PNGs are not supported');
  }

  const channels = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idatChunks));

  const bytesPerPixel = channels; // bitDepth 8
  const stride = width * bytesPerPixel;
  const out = new Uint8Array(width * height * 4);
  let prevRow = new Uint8Array(stride);

  let rawOffset = 0;
  for (let y = 0; y < height; y++) {
    const filterType = raw[rawOffset];
    rawOffset += 1;
    const row = new Uint8Array(stride);
    for (let x = 0; x < stride; x++) {
      const rawByte = raw[rawOffset + x];
      const a = x >= bytesPerPixel ? row[x - bytesPerPixel] : 0;
      const b = prevRow[x];
      const c = x >= bytesPerPixel ? prevRow[x - bytesPerPixel] : 0;
      let value: number;
      switch (filterType) {
        case 0:
          value = rawByte;
          break;
        case 1:
          value = (rawByte + a) & 0xff;
          break;
        case 2:
          value = (rawByte + b) & 0xff;
          break;
        case 3:
          value = (rawByte + ((a + b) >> 1)) & 0xff;
          break;
        case 4:
          value = (rawByte + paeth(a, b, c)) & 0xff;
          break;
        default:
          throw new Error(`decodePng: unsupported filter type ${filterType}`);
      }
      row[x] = value;
    }
    rawOffset += stride;

    for (let x = 0; x < width; x++) {
      const srcIdx = x * bytesPerPixel;
      const dstIdx = (y * width + x) * 4;
      out[dstIdx] = row[srcIdx];
      out[dstIdx + 1] = row[srcIdx + 1];
      out[dstIdx + 2] = row[srcIdx + 2];
      out[dstIdx + 3] = channels === 4 ? row[srcIdx + 3] : 255;
    }
    prevRow = row;
  }

  return { width, height, data: out };
}
