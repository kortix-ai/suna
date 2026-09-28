import { expect, test } from 'bun:test';
import { currentRuntimeArtifactFingerprint, runtimeArtifactsForBootMode } from './templates';

test('runtime fingerprint and boot-mode artifact closure remain stable', async () => {
  const fingerprint = await currentRuntimeArtifactFingerprint();
  expect(fingerprint).toMatch(/^kortix-runtime:.*:artifacts:[a-f0-9]{64}$/);
  expect(await currentRuntimeArtifactFingerprint()).toBe(fingerprint);
  const agent = runtimeArtifactsForBootMode('off').map(({ label }) => label);
  const nonAgent = runtimeArtifactsForBootMode('required').map(({ label }) => label);
  expect(agent).toEqual(['kortix-agent-src', 'kortix-agent-pkg', ...nonAgent]);
  expect(nonAgent).toContain('kortix-starter');
  expect(nonAgent).toContain('kortix-entrypoint');
});
