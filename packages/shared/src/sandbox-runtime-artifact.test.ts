import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  CLI_EXECUTOR_RUNTIME_FILES,
  buildCliExecutorSourceDigest,
  buildFileSha256,
} from './sandbox-runtime-artifact';

const roots: string[] = [];

async function createCliFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'kortix-cli-attestation-'));
  roots.push(root);
  for (const relativePath of CLI_EXECUTOR_RUNTIME_FILES) {
    const filePath =
      relativePath === 'src/executor'
        ? join(root, relativePath, 'gateway.ts')
        : join(root, relativePath);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, `${relativePath}:v1\n`);
  }
  await writeFile(join(root, 'package.json'), '{"name":"fixture"}\n');
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('sandbox CLI source digest', () => {
  test('changes when an in-sandbox Executor source file changes', async () => {
    const root = await createCliFixture();
    const before = await buildCliExecutorSourceDigest(root);

    await writeFile(join(root, 'src/commands/executor.ts'), 'executor:v2\n');

    expect(await buildCliExecutorSourceDigest(root)).not.toBe(before);
  });

  test('does not change for a laptop-only CLI command', async () => {
    const root = await createCliFixture();
    const before = await buildCliExecutorSourceDigest(root);

    await writeFile(join(root, 'src/commands/ship.ts'), 'ship:v2\n');

    expect(await buildCliExecutorSourceDigest(root)).toBe(before);
  });

  test('changes when a compiled artifact changes', async () => {
    const root = await createCliFixture();
    const binaryPath = join(root, 'dist', 'kortix');
    await mkdir(dirname(binaryPath), { recursive: true });
    await writeFile(binaryPath, 'binary:v1\n');
    const before = await buildFileSha256(binaryPath);

    await writeFile(binaryPath, 'binary:v2\n');

    expect(await buildFileSha256(binaryPath)).not.toBe(before);
  });
});
