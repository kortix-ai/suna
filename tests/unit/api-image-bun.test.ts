import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The API image runs the same Bun as every test lane. When they differed (image 1.2.23,
// tests 1.3/1.4), a Web API the image lacked passed every test and answered 500 on dev:
// CompressionStream in the global compress middleware (2026-08-26) and in the
// session-log restore route (2026-10-13).

const ROOT = join(import.meta.dirname, '..', '..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

describe('API image Bun', () => {
  it('equals the Bun of the test lanes', () => {
    const image = /^ARG BUN_VERSION=(\S+)$/m.exec(read('apps/api/Dockerfile'))?.[1];
    const tests = /bun-version: (\S+)/.exec(read('.github/workflows/tests.yml'))?.[1];
    expect(image).toMatch(/^\d+\.\d+\.\d+$/);
    expect(image).toBe(tests);
  });
});
