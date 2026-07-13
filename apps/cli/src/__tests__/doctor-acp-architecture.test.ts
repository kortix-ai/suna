import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

test('doctor delegates authenticated ACP transport to @kortix/sdk', () => {
  const source = readFileSync(new URL('../commands/doctor.ts', import.meta.url), 'utf8');
  expect(source).toContain('createKortix');
  expect(source).not.toContain('createAcpClient');
  expect(source).not.toMatch(/\bfetch\s*\(/);
});
