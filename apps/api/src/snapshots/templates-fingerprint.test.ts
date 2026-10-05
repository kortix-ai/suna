import { expect, test } from 'bun:test';
import { KORTIXD_SHARED_SOURCES } from '@kortix/api-contract/sandbox-layout';
import { currentRuntimeArtifactFingerprint, RUNTIME_ARTIFACTS } from './templates';

test('runtime fingerprint and artifact closure remain stable', async () => {
  const fingerprint = await currentRuntimeArtifactFingerprint();
  expect(fingerprint).toMatch(/^kortix-runtime:.*:artifacts:[a-f0-9]{64}$/);
  expect(await currentRuntimeArtifactFingerprint()).toBe(fingerprint);
  const labels = RUNTIME_ARTIFACTS.map(({ label }) => label);
  const nonAgent = labels.slice(2 + KORTIXD_SHARED_SOURCES.length);
  // The daemon binary bundles these contract files, so a change to one must
  // rebuild the snapshot like a change to the daemon's own source.
  expect(labels).toEqual([
    'kortix-agent-src',
    'kortix-agent-pkg',
    ...KORTIXD_SHARED_SOURCES.map((path) => `kortix-agent-shared:${path}`),
    ...nonAgent,
  ]);
  expect(nonAgent).toContain('kortix-starter');
  expect(nonAgent).toContain('kortix-entrypoint');
});
