// Pure pack reading for the push gate (push-manifest-check.ts): no I/O.

import { inflateSync } from 'node:zlib';

/**
 * The base object ids of a pack's REF_DELTA entries: what a thin pack expects
 * the receiver to already hold. Null when the pack cannot be walked (an
 * unknown version, a truncated entry). Walking needs each entry's compressed
 * length, which only inflating it reveals.
 */
export function refDeltaBases(pack: Uint8Array): string[] | null {
  const buf = Buffer.from(pack.buffer, pack.byteOffset, pack.byteLength);
  if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'PACK') return null;
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) return null;
  const count = buf.readUInt32BE(8);
  const bases = new Set<string>();
  let offset = 12;
  for (let entry = 0; entry < count; entry += 1) {
    if (offset >= buf.length) return null;
    let byte = buf[offset++]!;
    const type = (byte >> 4) & 7;
    while (byte & 0x80) {
      if (offset >= buf.length) return null;
      byte = buf[offset++]!;
    }
    if (type === 6) {
      // OFS_DELTA: a variable-length offset back into this pack.
      do {
        if (offset >= buf.length) return null;
        byte = buf[offset++]!;
      } while (byte & 0x80);
    } else if (type === 7) {
      if (offset + 20 > buf.length) return null;
      bases.add(buf.toString('hex', offset, offset + 20));
      offset += 20;
    }
    try {
      const { engine } = inflateSync(buf.subarray(offset), { info: true }) as unknown as { engine: { bytesWritten: number } };
      offset += engine.bytesWritten;
    } catch {
      return null;
    }
  }
  return [...bases];
}
