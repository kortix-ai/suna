#!/usr/bin/env node
// Generate the per-channel app icons from build/icon.png.
//
// WHY: three Kortix apps can now run at once. Three identical black icons in the
// Dock is unusable — you cannot tell which window is prod. So staging and dev
// get the SAME Kortix mark on a tinted substrate: instantly separable at 32px,
// still obviously Kortix, and the white mark is never recoloured.
//
// This is a GENERATOR, not a build step. Run it when build/icon.png changes and
// commit the output — CI consumes the committed .icns/.ico/.png. Keeping it out
// of the build means a broken image pipeline can never fail a release.
//
//   node scripts/make-channel-icons.js
//
// No dependencies: PNG in/out is done with node:zlib, the .ico container is
// written by hand, and .icns is produced by macOS `iconutil` (so this script
// must be run on a Mac — it refuses rather than emitting a broken .icns).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');

const BUILD_DIR = path.join(__dirname, '..', 'build');
const SOURCE = path.join(BUILD_DIR, 'icon.png');

// Substrate ramps, bottom → top of the existing icon's vertical gradient.
// Deliberately dark and desaturated: this is a build-channel marker, not
// decoration, and it has to sit calmly next to the black production icon.
const TINTS = {
  staging: { deep: [0x2b, 0x18, 0x03], light: [0x92, 0x40, 0x0e] }, // amber
  dev: { deep: [0x09, 0x10, 0x2a], light: [0x1e, 0x40, 0xaf] }, // blue
};

/* ─── PNG ────────────────────────────────────────────────────────────────── */

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Decode a non-interlaced 8-bit RGB/RGBA PNG to {width, height, data:RGBA}. */
function decodePng(buf) {
  if (!buf.subarray(0, 8).equals(PNG_MAGIC)) throw new Error('not a PNG');
  let off = 8;
  let ihdr = null;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const body = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      ihdr = {
        width: body.readUInt32BE(0),
        height: body.readUInt32BE(4),
        depth: body[8],
        colorType: body[9],
        interlace: body[12],
      };
    } else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (!ihdr) throw new Error('no IHDR');
  if (ihdr.depth !== 8) throw new Error(`unsupported bit depth ${ihdr.depth}`);
  if (ihdr.interlace !== 0) throw new Error('interlaced PNG unsupported');
  const channels = ihdr.colorType === 6 ? 4 : ihdr.colorType === 2 ? 3 : 0;
  if (!channels) throw new Error(`unsupported color type ${ihdr.colorType}`);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const { width, height } = ihdr;
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4);
  const prev = Buffer.alloc(stride);
  const line = Buffer.alloc(stride);

  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    raw.copy(line, 0, y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    // PNG filters operate on the byte `channels` positions back, not one back.
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      line[i] = v & 0xff;
    }
    line.copy(prev);
    for (let x = 0; x < width; x++) {
      const s = x * channels;
      const d = (y * width + x) * 4;
      out[d] = line[s];
      out[d + 1] = line[s + 1];
      out[d + 2] = line[s + 2];
      out[d + 3] = channels === 4 ? line[s + 3] : 0xff;
    }
  }
  return { width, height, data: out };
}

function chunk(type, body) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(typed) >>> 0);
  return Buffer.concat([len, typed, crc]);
}

/** Encode RGBA to PNG with filter 0 — simple, and these are tiny images. */
function encodePng({ width, height, data }) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    PNG_MAGIC,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ─── Image ops ──────────────────────────────────────────────────────────── */

/** Box-filter downscale. Averages in premultiplied space so transparent pixels
 *  can't drag colour into the edges of the rounded square. */
function resize(img, size) {
  const out = Buffer.alloc(size * size * 4);
  const scale = img.width / size;
  for (let y = 0; y < size; y++) {
    const y0 = Math.floor(y * scale);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * scale));
    for (let x = 0; x < size; x++) {
      const x0 = Math.floor(x * scale);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * scale));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * img.width + sx) * 4;
          const al = img.data[i + 3] / 255;
          r += img.data[i] * al;
          g += img.data[i + 1] * al;
          b += img.data[i + 2] * al;
          a += img.data[i + 3];
          n++;
        }
      }
      const d = (y * size + x) * 4;
      const alpha = a / n;
      const un = alpha > 0 ? n * (alpha / 255) : 1;
      out[d] = Math.round(r / un);
      out[d + 1] = Math.round(g / un);
      out[d + 2] = Math.round(b / un);
      out[d + 3] = Math.round(alpha);
    }
  }
  return { width: size, height: size, data: out };
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;

function smoothstep(edge0, edge1, x) {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/**
 * Recolour the dark substrate onto a channel ramp, leaving the white mark and
 * the drop shadow alone.
 *
 *   mark      luminance ≳ 0.45 → the Kortix glyph. Never touched, so the brand
 *             mark reads identically on all three icons.
 *   substrate luminance ≲ 0.45 → mapped across the ramp by its own brightness,
 *             which preserves the original top-to-bottom gradient.
 *   shadow    alpha < 1 → left neutral. Tinting it would ring the icon in
 *             coloured haze against a light Dock.
 */
function tintSubstrate(img, { deep, light }) {
  const data = Buffer.from(img.data);
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a === 0) continue;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

    const markness = smoothstep(0.35, 0.6, lum);
    const opaque = smoothstep(180, 250, a); // shadow → 0, body → 1
    const amount = (1 - markness) * opaque;
    if (amount <= 0) continue;

    // The source substrate spans roughly luminance 0.02–0.18; stretch that band
    // across the full ramp so the gradient survives the recolour.
    const t = clamp01(lum / 0.18);
    for (let k = 0; k < 3; k++) {
      const target = lerp(deep[k], light[k], t);
      data[i + k] = Math.round(lerp(data[i + k], target, amount));
    }
  }
  return { width: img.width, height: img.height, data };
}

/* ─── Containers ─────────────────────────────────────────────────────────── */

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

/** PNG-compressed ICO. Windows Vista+ reads PNG entries directly. */
function buildIco(img) {
  const entries = ICO_SIZES.map((s) => ({ size: s, png: encodePng(resize(img, s)) }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);

  const dir = Buffer.alloc(16 * entries.length);
  let offset = header.length + dir.length;
  entries.forEach((e, i) => {
    const o = i * 16;
    dir[o] = e.size === 256 ? 0 : e.size; // 0 means 256
    dir[o + 1] = e.size === 256 ? 0 : e.size;
    dir[o + 2] = 0; // palette
    dir[o + 3] = 0; // reserved
    dir.writeUInt16LE(1, o + 4); // colour planes
    dir.writeUInt16LE(32, o + 6); // bits per pixel
    dir.writeUInt32BE(0, o + 8);
    dir.writeUInt32LE(e.png.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += e.png.length;
  });
  return Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
}

// macOS iconset naming. 512x512@2x (1024px) is required for a modern .icns —
// without it Finder and the Dock fall back to a blurry upscale.
const ICONSET = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024],
];

function buildIcns(img, outPath) {
  if (process.platform !== 'darwin') {
    throw new Error('.icns generation needs macOS `iconutil` — run this script on a Mac.');
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kortix-icons-')) + '/icon.iconset';
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, size] of ICONSET) {
    // 1024 is an upscale of the 512 source; nearest-neighbour doubling keeps the
    // edges crisp rather than inventing blur.
    fs.writeFileSync(path.join(dir, name), encodePng(size > img.width ? upscale2x(img) : resize(img, size)));
  }
  execFileSync('iconutil', ['-c', 'icns', dir, '-o', outPath]);
  fs.rmSync(path.dirname(dir), { recursive: true, force: true });
}

function upscale2x(img) {
  const w = img.width * 2;
  const out = Buffer.alloc(w * w * 4);
  for (let y = 0; y < w; y++) {
    for (let x = 0; x < w; x++) {
      const s = (Math.floor(y / 2) * img.width + Math.floor(x / 2)) * 4;
      img.data.copy(out, (y * w + x) * 4, s, s + 4);
    }
  }
  return { width: w, height: w, data: out };
}

/* ─── Main ───────────────────────────────────────────────────────────────── */

const source = decodePng(fs.readFileSync(SOURCE));
if (source.width !== source.height || source.width < 512) {
  throw new Error(`build/icon.png must be square and ≥512px (got ${source.width}x${source.height})`);
}

for (const [channel, tint] of Object.entries(TINTS)) {
  const tinted = tintSubstrate(source, tint);
  const png = path.join(BUILD_DIR, `icon-${channel}.png`);
  const ico = path.join(BUILD_DIR, `icon-${channel}.ico`);
  const icns = path.join(BUILD_DIR, `icon-${channel}.icns`);
  fs.writeFileSync(png, encodePng(tinted));
  fs.writeFileSync(ico, buildIco(tinted));
  buildIcns(tinted, icns);
  console.log(
    `icon-${channel}: ${path.basename(png)} ${fs.statSync(png).size}B, ` +
      `${path.basename(ico)} ${fs.statSync(ico).size}B, ` +
      `${path.basename(icns)} ${fs.statSync(icns).size}B`,
  );
}
