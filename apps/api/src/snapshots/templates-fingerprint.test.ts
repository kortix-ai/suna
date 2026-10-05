import { expect, test } from 'bun:test';
import { KORTIXD_SHARED_SOURCES } from '@kortix/api-contract/sandbox-layout';
import { currentRuntimeArtifactFingerprint, runtimeArtifactsForBootMode } from './templates';

test('runtime fingerprint and boot-mode artifact closure remain stable', async () => {
  const fingerprint = await currentRuntimeArtifactFingerprint();
  expect(fingerprint).toMatch(/^kortix-runtime:.*:artifacts:[a-f0-9]{64}$/);
  expect(await currentRuntimeArtifactFingerprint()).toBe(fingerprint);
  const agent = runtimeArtifactsForBootMode('off').map(({ label }) => label);
  const nonAgent = runtimeArtifactsForBootMode('required').map(({ label }) => label);
  // The daemon binary bundles these contract files, so a change to one must
  // rebuild the snapshot like a change to the daemon's own source.
  expect(agent).toEqual([
    'kortix-agent-src',
    'kortix-agent-pkg',
    ...KORTIXD_SHARED_SOURCES.map((path) => `kortix-agent-shared:${path}`),
    ...nonAgent,
  ]);
  expect(nonAgent).toContain('kortix-starter');
  expect(nonAgent).toContain('kortix-entrypoint');
});
