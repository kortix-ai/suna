import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The API image runs the Bun of `ARG BUN_VERSION` in apps/api/Dockerfile (1.2 → 1.2.23).
// Every laptop and test lane runs a newer Bun. Bun 1.2 has no `CompressionStream` or
// `DecompressionStream`, so code that uses them passes every local test and answers 500
// on dev: the global compress middleware on 2026-08-26, the session-log restore route
// (`hono/compress`) on 2026-10-13. Only `middleware/compress.ts` may use them: it
// feature-detects and falls back to node:zlib, and compress.test.ts pins that path.
// The guard retires itself when the image moves to Bun 1.3 or later.

const ROOT = join(import.meta.dirname, '..', '..');
const ALLOWED = 'apps/api/src/middleware/compress.ts';

function imageBun(): [number, number] {
  const dockerfile = readFileSync(join(ROOT, 'apps/api/Dockerfile'), 'utf8');
  const version = /^ARG BUN_VERSION=(\d+)\.(\d+)/m.exec(dockerfile);
  if (!version) throw new Error('apps/api/Dockerfile has no ARG BUN_VERSION=<major>.<minor>');
  return [Number(version[1]), Number(version[2])];
}

function uses(): string[] {
  try {
    return execFileSync(
      'git',
      ['grep', '-lE', 'hono/compress|CompressionStream|DecompressionStream', '--', 'apps/api/src', ':!*.test.ts'],
      { cwd: ROOT, encoding: 'utf8' },
    ).split('\n').filter((file) => file && file !== ALLOWED);
  } catch (error) {
    // `git grep` exits 1 when nothing matches.
    if ((error as { status?: number }).status === 1) return [];
    throw error;
  }
}

describe('API code uses only Web APIs the image Bun has', () => {
  it('no CompressionStream, DecompressionStream or hono/compress while the image runs Bun < 1.3', () => {
    const [major, minor] = imageBun();
    if (major > 1 || (major === 1 && minor >= 3)) return;
    // ponytail: names the APIs that already broke dev; add one here when another Bun 1.2 gap bites.
    expect(uses(), `Bun ${major}.${minor} in the API image has none of these. Use node:zlib (Bun.gzipSync) or the global compressResponse.`).toEqual([]);
  });
});
