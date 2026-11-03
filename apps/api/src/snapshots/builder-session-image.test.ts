import { describe, expect, test } from 'bun:test';
import { bootedImageOf, ensureSessionImage, type EnsureSandboxImageResult, type ImageStep } from './builder';

const project = { projectId: 'project-1', repoUrl: 'file:///nowhere', defaultBranch: 'main', manifestPath: 'kortix.yaml' };
const image = (snapshotName: string): EnsureSandboxImageResult => ({
  snapshotName,
  slug: 'default',
  contentHash: `hash-${snapshotName}`,
  built: false,
  isDefault: true,
  spec: { cpu: 2, memoryGb: 4, diskGb: 20 },
});

/** A resolution that reports `steps`, then answers after `ms`. */
function resolution(steps: ImageStep[], ms: number, answer = image('wanted')) {
  return (async (_project: unknown, opts: { onStep?: (step: ImageStep) => void } = {}) => {
    for (const step of steps) opts.onStep?.(step);
    await new Promise((resolve) => setTimeout(resolve, ms));
    return answer;
  }) as never;
}

describe('ensureSessionImage', () => {
  test('a resolution inside the budget is the answer, and every step reaches the caller', async () => {
    const seen: ImageStep[] = [];
    const result = await ensureSessionImage(project, {
      budgetMs: 200,
      onStep: (step) => seen.push(step),
      resolve: resolution([{ state: 'resolving', image: null }], 5),
      lastBooted: async () => image('previous'),
    });
    expect(result.snapshotName).toBe('wanted');
    expect(seen).toEqual([{ state: 'resolving', image: null }]);
  });

  test('over the budget, the session boots the image its project booted last and says so', async () => {
    const seen: ImageStep[] = [];
    const started = Date.now();
    const result = await ensureSessionImage(project, {
      budgetMs: 30,
      onStep: (step) => seen.push(step),
      resolve: resolution([{ state: 'resolving', image: null }], 400),
      lastBooted: async () => image('previous'),
    });
    expect(Date.now() - started).toBeLessThan(300);
    expect(result.snapshotName).toBe('previous');
    expect(result.spec).toEqual({ cpu: 2, memoryGb: 4, diskGb: 20 });
    expect(seen.at(-1)).toEqual({ state: 'serving_last_ready', image: 'previous' });
  });

  for (const state of ['building', 'waiting_for_build'] as const) {
    test(`a resolution that reports ${state} hands over the earlier boot at once, not after the budget`, async () => {
      const seen: ImageStep[] = [];
      const started = Date.now();
      const result = await ensureSessionImage(project, {
        budgetMs: 5_000,
        onStep: (step) => seen.push(step),
        resolve: resolution([{ state: 'resolving', image: null }, { state, image: 'wanted' }], 400),
        lastBooted: async () => image('previous'),
      });
      expect(Date.now() - started).toBeLessThan(300);
      expect(result.snapshotName).toBe('previous');
      expect(seen.map((step) => step.state)).toEqual(['resolving', state, 'serving_last_ready']);
    });
  }

  test('a build with no earlier boot still waits for the image', async () => {
    const result = await ensureSessionImage(project, {
      budgetMs: 5_000,
      resolve: resolution([{ state: 'building', image: 'wanted' }], 40),
      lastBooted: async () => null,
    });
    expect(result.snapshotName).toBe('wanted');
  });

  test('steps the slow resolution reports after the fallback do not reach the caller', async () => {
    const seen: ImageStep[] = [];
    const slow = (async (_project: unknown, opts: { onStep?: (step: ImageStep) => void } = {}) => {
      opts.onStep?.({ state: 'resolving', image: null });
      await new Promise((resolve) => setTimeout(resolve, 80));
      opts.onStep?.({ state: 'building', image: 'wanted' });
      return image('wanted');
    }) as never;
    await ensureSessionImage(project, { budgetMs: 20, onStep: (step) => seen.push(step), resolve: slow, lastBooted: async () => image('previous') });
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(seen.map((step) => step.state)).toEqual(['resolving', 'serving_last_ready']);
  });

  test('with no earlier boot, the session waits for its image and sees every step', async () => {
    const seen: ImageStep[] = [];
    const result = await ensureSessionImage(project, {
      budgetMs: 20,
      onStep: (step) => seen.push(step),
      resolve: resolution([{ state: 'resolving', image: null }, { state: 'building', image: 'wanted' }], 80),
      lastBooted: async () => null,
    });
    expect(result.snapshotName).toBe('wanted');
    expect(seen.map((step) => step.state)).toEqual(['resolving', 'building']);
  });

  test('a failed lookup of the earlier boot falls back to waiting, never to an error', async () => {
    const result = await ensureSessionImage(project, {
      budgetMs: 20,
      resolve: resolution([], 60),
      lastBooted: async () => {
        throw new Error('database unavailable');
      },
    });
    expect(result.snapshotName).toBe('wanted');
  });
});

describe('bootedImageOf', () => {
  const artifact = {
    providerArtifactRef: 'kortix-default-abc',
    contentHash: 'abc',
    sandboxSlug: 'default',
    provider: 'platinum',
    isPlatformDefault: true,
    runtimeProfile: 'standard',
    spec: { cpu: 2, memoryGb: 4, diskGb: 20 },
  };

  test('a complete record for the template and provider is a bootable image', () => {
    expect(bootedImageOf(artifact, 'default', 'platinum')).toMatchObject({ snapshotName: 'kortix-default-abc', built: false, isDefault: true });
  });

  test('another template, another provider, or no machine size is not', () => {
    expect(bootedImageOf(artifact, 'gpu', 'platinum')).toBeNull();
    expect(bootedImageOf(artifact, 'default', 'daytona')).toBeNull();
    expect(bootedImageOf({ ...artifact, spec: undefined }, 'default', 'platinum')).toBeNull();
    expect(bootedImageOf(null, 'default', 'platinum')).toBeNull();
  });
});
