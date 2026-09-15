import { expect, test } from 'bun:test';
import { prebuildPiEnvironmentImages } from './pi-environment-prebuild';

const project = { projectId: 'project', repoUrl: 'https://git.test/project', defaultBranch: 'main', manifestPath: 'kortix.yaml' };
const sha = 'a'.repeat(40);

test('prebuilds distinct enabled agent environments at the pinned commit, with bounded concurrency', async () => {
  const calls: Array<{ ref: string; slug: string; provider: string; source: string }> = [];
  const gates: Array<() => void> = [];
  let active = 0;
  let maximum = 0;
  const pending = prebuildPiEnvironmentImages(project, sha, {
    enabled: () => true,
    load: async pinned => {
      expect(pinned.defaultBranch).toBe(sha);
      return { projectDefault: 'python', agents: [
        { enabled: true, sandbox: 'python' }, { enabled: true, sandbox: null },
        { enabled: true, sandbox: 'browser' }, { enabled: true, sandbox: 'data' },
        { enabled: false, sandbox: 'disabled' },
      ] };
    },
    build: async (pinned, options) => {
      calls.push({ ref: pinned.defaultBranch, ...options });
      maximum = Math.max(maximum, ++active);
      await new Promise<void>(resolve => gates.push(resolve));
      active--;
    },
    failed: () => { throw new Error('unexpected failure'); },
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(calls).toHaveLength(2);
  gates.splice(0).forEach(resolve => resolve());
  await new Promise(resolve => setTimeout(resolve, 0));
  gates.splice(0).forEach(resolve => resolve());
  await pending;
  expect(maximum).toBe(2);
  expect(calls).toEqual(['python', 'browser', 'data'].map(slug => ({ ref: sha, slug, provider: 'daytona', source: 'background' })));
});

test('disabled Daytona does no reads and a failed template does not suppress its sibling', async () => {
  const calls: string[] = [];
  const dependencies = {
    enabled: () => false,
    load: async () => { calls.push('load'); return { projectDefault: null, agents: [{ enabled: true, sandbox: 'broken' }, { enabled: true, sandbox: null }] }; },
    build: async (_project: typeof project, options: { slug: string }) => {
      calls.push(options.slug);
      if (options.slug === 'broken') throw new Error('invalid Dockerfile');
    },
    failed: (slug: string, error: unknown) => { calls.push(`failed:${slug}:${(error as Error).message}`); },
  };
  await prebuildPiEnvironmentImages(project, sha, dependencies);
  expect(calls).toEqual([]);
  await prebuildPiEnvironmentImages(project, sha, { ...dependencies, enabled: () => true });
  expect(calls).toEqual(['load', 'broken', 'default', 'failed:broken:invalid Dockerfile']);
});

test('refuses invalid source identity before any build and ignores the reserved worker template', async () => {
  const calls: string[] = [];
  const dependencies = {
    enabled: () => true,
    load: async () => ({ projectDefault: 'pi-worker', agents: [{ enabled: true, sandbox: 'pi-worker' }] }),
    build: async (_project: typeof project, options: { slug: string }) => { calls.push(options.slug); },
    failed: () => {},
  };
  await expect(prebuildPiEnvironmentImages(project, 'main', dependencies)).rejects.toThrow('commit');
  expect(calls).toEqual([]);
  await prebuildPiEnvironmentImages(project, sha, dependencies);
  expect(calls).toEqual(['default']);
});
