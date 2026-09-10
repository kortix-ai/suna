import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recoverLegacyPiWorkerIdentity, PI_ARTIFACT_IDENTITY_SCRIPT } from './pi-worker-identity-recovery';

const metadata = { sandbox_slug: 'pi-worker', name: 'existing conversation' };
const identity = { project_id: 'project', ref: 'main', source_sha: 'a'.repeat(40), engine: 'pi', format: 'kortix.compiled-pi-runtime.v1' };
const sandbox = { provider: 'daytona', externalId: 'worker', metadata: { pi_worker_boot: true } };

test('legacy identity uses the installed artifact, never the current branch HEAD', async () => {
  const recovered = await recoverLegacyPiWorkerIdentity({ projectId: 'project', metadata, sandbox, readArtifact: async () => identity });
  expect(recovered).toEqual({ ref: 'main', sha: 'a'.repeat(40) });
});

test.each([
  { ...identity, project_id: 'another-project' },
  { ...identity, source_sha: 'main' },
  { ...identity, ref: 'main\n' },
  { ...identity, engine: 'opencode' },
  { ...identity, format: 'unknown' },
])('rejects an unrelated or malformed installed artifact %j', async (artifact) => {
  expect(await recoverLegacyPiWorkerIdentity({ projectId: 'project', metadata, sandbox, readArtifact: async () => artifact })).toBeNull();
});

test('a forged Pi label without a server-owned worker does not read the provider', async () => {
  let reads = 0;
  expect(await recoverLegacyPiWorkerIdentity({ projectId: 'project', metadata, sandbox: { ...sandbox, metadata: {} }, readArtifact: async () => { reads++; return identity; } })).toBeNull();
  expect(reads).toBe(0);
});

test('a malformed explicit identity is not replaced by legacy recovery', async () => {
  let reads = 0;
  expect(await recoverLegacyPiWorkerIdentity({ projectId: 'project', metadata: { ...metadata, pi_worker_sha: 'invalid' }, sandbox, readArtifact: async () => { reads++; return identity; } })).toBeNull();
  expect(reads).toBe(0);
});

test('reads only artifact metadata without executing custom Pi code', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-identity-'));
  try {
    const artifact = join(root, 'session-worker.mjs');
    await writeFile(artifact, '#!/usr/bin/env node\n// kortix-manifest-base64url:' + Buffer.from(JSON.stringify({ ...identity, agent_config: 'private configuration' })).toString('base64url') + '\nthrow new Error("MUST NOT EXECUTE");');
    const child = Bun.spawn(['node', '-e', PI_ARTIFACT_IDENTITY_SCRIPT, artifact], { stdout: 'pipe', stderr: 'pipe' });
    const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code).toBe(0);
    expect(error).toBe('');
    expect(JSON.parse(output)).toEqual(identity);
    expect(output).not.toContain('private configuration');
  } finally { await rm(root, { recursive: true, force: true }); }
});
