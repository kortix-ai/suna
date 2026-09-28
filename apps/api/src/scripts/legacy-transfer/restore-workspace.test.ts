import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';

test('workspace restore preserves files and empty directories and rejects incomplete evidence', () => {
  const result = Bun.spawnSync([process.env.LEGACY_TRANSFER_PYTHON ?? 'python3.12', '-B', fileURLToPath(new URL('./restore-workspace.test.py', import.meta.url))]);
  expect(result.stderr.toString()).toContain('Ran 9 tests');
  expect(result.exitCode).toBe(0);
});
