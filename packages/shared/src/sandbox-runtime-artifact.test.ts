import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  CLI_CONNECTOR_RUNTIME_FILES,
  buildCliConnectorSourceDigest,
  buildFileSha256,
} from './sandbox-runtime-artifact';

const roots: string[] = [];

async function createCliFixture(): Promise<{ cliRoot: string; sdkRoot: string }> {
  const root = await mkdtemp(join(tmpdir(), 'kortix-cli-attestation-'));
  roots.push(root);
  const cliRoot = join(root, 'apps', 'cli');
  const sdkRoot = join(root, 'packages', 'sdk');
  for (const relativePath of CLI_CONNECTOR_RUNTIME_FILES) {
    const filePath =
      relativePath === 'src/connector-gateway'
        ? join(cliRoot, relativePath, 'gateway.ts')
        : join(cliRoot, relativePath);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, `${relativePath}:v1\n`);
  }
  await writeFile(join(cliRoot, 'package.json'), '{"name":"@kortix/cli"}\n');
  await mkdir(join(sdkRoot, 'src'), { recursive: true });
  await writeFile(join(sdkRoot, 'src', 'index.ts'), 'export const sdk = "v1";\n');
  await writeFile(join(sdkRoot, 'package.json'), '{"name":"@kortix/sdk"}\n');
  return { cliRoot, sdkRoot };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('sandbox CLI source digest', () => {
  test('changes when an in-sandbox Connector source file changes', async () => {
    const { cliRoot, sdkRoot } = await createCliFixture();
    const before = await buildCliConnectorSourceDigest(cliRoot, sdkRoot);

    await writeFile(join(cliRoot, 'src/commands/connector-gateway.ts'), 'connector-gateway:v2\n');

    expect(await buildCliConnectorSourceDigest(cliRoot, sdkRoot)).not.toBe(before);
  });

  test('does not change for a laptop-only CLI command', async () => {
    const { cliRoot, sdkRoot } = await createCliFixture();
    const before = await buildCliConnectorSourceDigest(cliRoot, sdkRoot);

    await writeFile(join(cliRoot, 'src/commands/ship.ts'), 'ship:v2\n');

    expect(await buildCliConnectorSourceDigest(cliRoot, sdkRoot)).toBe(before);
  });

  test('changes when the unified SDK source changes', async () => {
    const { cliRoot, sdkRoot } = await createCliFixture();
    const before = await buildCliConnectorSourceDigest(cliRoot, sdkRoot);

    await writeFile(join(sdkRoot, 'src', 'index.ts'), 'export const sdk = "v2";\n');

    expect(await buildCliConnectorSourceDigest(cliRoot, sdkRoot)).not.toBe(before);
  });

  test('changes when a compiled artifact changes', async () => {
    const { cliRoot } = await createCliFixture();
    const binaryPath = join(cliRoot, 'dist', 'kortix');
    await mkdir(dirname(binaryPath), { recursive: true });
    await writeFile(binaryPath, 'binary:v1\n');
    const before = await buildFileSha256(binaryPath);

    await writeFile(binaryPath, 'binary:v2\n');

    expect(await buildFileSha256(binaryPath)).not.toBe(before);
  });
});
