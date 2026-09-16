import { expect, test } from 'bun:test';
import { currentRuntimeArtifactFingerprint } from './templates';

test('baked daemon requirements retain their own fingerprint with compiled boot enabled', async () => {
  const [compiled, baked, shadow, required] = await Promise.all([
    currentRuntimeArtifactFingerprint('prefer'),
    currentRuntimeArtifactFingerprint('off'),
    currentRuntimeArtifactFingerprint('shadow'),
    currentRuntimeArtifactFingerprint('required'),
  ]);
  expect(baked).not.toBe(compiled);
  expect(shadow).toBe(baked);
  expect(required).toBe(compiled);
  expect(await currentRuntimeArtifactFingerprint('off')).toBe(baked);
  expect(await currentRuntimeArtifactFingerprint('prefer')).toBe(compiled);
});
