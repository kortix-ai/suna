/**
 * gzip and Zstandard streams for snapshot archives.
 *
 * Zstandard landed in `node:zlib` (Node 22.15 / 23.8) and is present in every
 * runtime this repository ships — verified on `oven/bun:1.2` (bun 1.2.23) and
 * `oven/bun:1.3.11`, the API and sandbox-agent pins in `apps/api/Dockerfile`.
 * The installed `@types/node` predates it, so the two functions are reached
 * through one narrowly typed accessor here instead of scattering casts.
 */
import * as zlib from 'node:zlib';
import type { Transform } from 'node:stream';

type ZstdZlib = {
  createZstdCompress?: (options?: unknown) => Transform;
  createZstdDecompress?: (options?: unknown) => Transform;
};

export function zstdSupported(): boolean {
  const z = zlib as unknown as ZstdZlib;
  return typeof z.createZstdCompress === 'function' && typeof z.createZstdDecompress === 'function';
}

export function createCompressor(compression: 'gzip' | 'zstd'): Transform {
  if (compression !== 'zstd') {
    // MTIME 0 in the gzip header, so two runs over identical input produce
    // identical bytes. Zstandard carries no timestamp at all.
    return zlib.createGzip({ level: 9 });
  }
  const create = (zlib as unknown as ZstdZlib).createZstdCompress;
  if (!create) throw new Error('Zstandard compression is unavailable in this runtime');
  return create();
}

export function createDecompressor(compression: 'gzip' | 'zstd'): Transform {
  if (compression !== 'zstd') return zlib.createGunzip();
  const create = (zlib as unknown as ZstdZlib).createZstdDecompress;
  if (!create) throw new Error('Zstandard decompression is unavailable in this runtime');
  return create();
}
