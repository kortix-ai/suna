import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repoRoot = resolve(import.meta.dir, '../../../..');

describe('API image sandbox runtime artifacts', () => {
  test('copies every file staged by the runtime snapshot builder', () => {
    const dockerfile = readFileSync(resolve(repoRoot, 'apps/api/Dockerfile'), 'utf8');

    expect(dockerfile).toContain(
      'COPY apps/sandbox/opencode-warmup.sh ./apps/sandbox/opencode-warmup.sh',
    );
    expect(dockerfile).toContain('COPY apps/sandbox/MACHINE.md ./apps/sandbox/MACHINE.md');
  });
});
