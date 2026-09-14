import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

test('standalone package links skip incomplete traced package directories', () => {
  const root = mkdtempSync(join(tmpdir(), 'kortix-standalone-links-'));
  roots.push(root);

  const staleNext = join(root, 'node_modules/.pnpm/next@16.3.0/node_modules/next');
  const completeNext = join(root, 'node_modules/.pnpm/next@16.3.3/node_modules/next');
  mkdirSync(join(staleNext, 'dist'), { recursive: true });
  mkdirSync(completeNext, { recursive: true });
  writeFileSync(join(completeNext, 'package.json'), '{"name":"next"}\n');

  const result = Bun.spawnSync({
    cmd: ['sh', join(import.meta.dir, 'link-standalone-packages.sh')],
    env: { ...process.env, STANDALONE_ROOT: root },
  });

  expect(result.exitCode).toBe(0);
  expect(readlinkSync(join(root, 'apps/web/node_modules/next'))).toBe(completeNext);
});
