import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  CLI_EXECUTOR_RUNTIME_FILES,
  buildCliExecutorSourceDigest,
  buildFileSha256,
} from '@kortix/shared/sandbox-runtime-artifact';
import { assertCliArtifactAttested } from './cli-artifact-attestation';

const roots: string[] = [];

async function createCliFixture(): Promise<{
  cliRoot: string;
  binaryPath: string;
  attestationPath: string;
}> {
  const cliRoot = await mkdtemp(join(tmpdir(), 'kortix-cli-artifact-'));
  roots.push(cliRoot);
  for (const relativePath of CLI_EXECUTOR_RUNTIME_FILES) {
    const filePath =
      relativePath === 'src/executor'
        ? join(cliRoot, relativePath, 'gateway.ts')
        : join(cliRoot, relativePath);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, `${relativePath}:v1\n`);
  }
  await writeFile(join(cliRoot, 'package.json'), '{"name":"fixture"}\n');
  const binaryPath = join(cliRoot, 'dist', 'kortix');
  const attestationPath = join(cliRoot, 'dist', 'kortix-executor-runtime.attestation.json');
  await mkdir(dirname(attestationPath), { recursive: true });
  await writeFile(binaryPath, 'binary:v1\n');
  return { cliRoot, binaryPath, attestationPath };
}

async function writeAttestation(
  fixture: Awaited<ReturnType<typeof createCliFixture>>,
): Promise<string> {
  const digest = await buildCliExecutorSourceDigest(fixture.cliRoot);
  await writeFile(
    fixture.attestationPath,
    `${JSON.stringify({
      schema_version: 1,
      source_sha256: digest,
      binary_sha256: await buildFileSha256(fixture.binaryPath),
      target: 'bun-linux-x64',
    })}\n`,
  );
  return digest;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('sandbox CLI artifact attestation', () => {
  test('accepts the digest produced from the current Executor source', async () => {
    const fixture = await createCliFixture();
    const digest = await writeAttestation(fixture);

    await expect(assertCliArtifactAttested(fixture)).resolves.toBe(digest);
  });

  test('rejects a compiled artifact after Executor source changes', async () => {
    const fixture = await createCliFixture();
    await writeAttestation(fixture);
    await writeFile(join(fixture.cliRoot, 'src/commands/executor.ts'), 'executor:v2\n');

    await expect(assertCliArtifactAttested(fixture)).rejects.toThrow(
      'Compiled sandbox CLI is stale',
    );
  });

  test('rejects a binary that does not match its attestation', async () => {
    const fixture = await createCliFixture();
    await writeAttestation(fixture);
    await writeFile(fixture.binaryPath, 'binary:v2\n');

    await expect(assertCliArtifactAttested(fixture)).rejects.toThrow(
      'Compiled sandbox CLI does not match its attestation',
    );
  });

  test('rejects a non-Linux compile target', async () => {
    const fixture = await createCliFixture();
    await writeAttestation(fixture);
    const value = JSON.parse(await readFile(fixture.attestationPath, 'utf8'));
    value.target = 'bun-darwin-arm64';
    await writeFile(fixture.attestationPath, `${JSON.stringify(value)}\n`);

    await expect(assertCliArtifactAttested(fixture)).rejects.toThrow(
      'Invalid CLI artifact attestation',
    );
  });

  test('rejects a missing attestation', async () => {
    const fixture = await createCliFixture();

    await expect(assertCliArtifactAttested(fixture)).rejects.toThrow(
      'Required CLI artifact attestation missing',
    );
  });
});
