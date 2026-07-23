import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('the shared sandbox resume path contains no OpenCode-specific readiness metadata', () => {
  const source = readFileSync(join(import.meta.dir, '..', 'projects', 'routes', 'shared.ts'), 'utf8');

  expect(source).not.toContain('opencodeReadyWaitStartedAt');
  expect(source).not.toContain('opencodeReadyWaitReason');
});
