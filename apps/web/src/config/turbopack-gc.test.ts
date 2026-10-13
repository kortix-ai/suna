import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const nextConfig = readFileSync(new URL('../../next.config.ts', import.meta.url), 'utf8');

describe('Turbopack persistent cache', () => {
  // Without GC, .next/dev/cache/turbopack keeps every task ever computed and
  // reached 20-60GB per busy worktree (learnings entry 2026-10-09).
  test('garbage-collects the persistent cache', () => {
    expect(nextConfig).toMatch(/^\s*turbopackGc:\s*true,/m);
  });
});
