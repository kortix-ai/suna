import { deflateSync } from 'node:zlib';
import { buildTeamsManifest, type BuildTeamsManifestConfig } from '../teams-manifest';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(
  width: number,
  height: number,
  pixel: (x: number, y: number) => [number, number, number, number],
): Buffer {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc(height * (1 + width * 4));
  let p = 0;
  for (let y = 0; y < height; y += 1) {
    raw[p++] = 0;
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = pixel(x, y);
      raw[p++] = r;
      raw[p++] = g;
      raw[p++] = b;
      raw[p++] = a;
    }
  }
  const idat = deflateSync(raw);
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}

function colorIcon(): Buffer {
  const size = 192;
  const cx = size / 2;
  const cy = size / 2;
  const rr = 60 * 60;
  return encodePng(size, size, (x, y) => {
    const d = (x - cx) ** 2 + (y - cy) ** 2;
    return d <= rr ? [255, 255, 255, 255] : [10, 10, 10, 255];
  });
}

function outlineIcon(): Buffer {
  const size = 32;
  const cx = size / 2;
  const cy = size / 2;
  const rr = 13 * 13;
  return encodePng(size, size, (x, y) => {
    const d = (x - cx) ** 2 + (y - cy) ** 2;
    return d <= rr ? [255, 255, 255, 255] : [0, 0, 0, 0];
  });
}

function zipStore(files: Array<{ name: string; data: Buffer }>): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const crc = crc32(f.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(f.data.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, f.data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(f.data.length, 20);
    cd.writeUInt32LE(f.data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);

    offset += local.length + name.length + f.data.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cdBuf, eocd]);
}

export function buildTeamsAppPackage(cfg: BuildTeamsManifestConfig): Buffer {
  const manifest = buildTeamsManifest(cfg);
  return zipStore([
    { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') },
    { name: 'color.png', data: colorIcon() },
    { name: 'outline.png', data: outlineIcon() },
  ]);
}
