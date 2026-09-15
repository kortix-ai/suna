import { expect, test } from 'bun:test';
import { prebuildStartupImages } from './startup-prebuild';

test('starts supported images concurrently and isolates an individual build failure', async () => {
  const calls: string[] = [];
  const results: unknown[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const build = (kind: string) => async ({ provider, source }: { provider: string; source: 'startup' }) => {
    calls.push(`${kind}:${provider}:${source}`);
    if (kind === 'default' && provider === 'daytona') await gate;
    if (kind === 'meta') throw new Error('build unavailable');
    return { snapshotName: `${kind}-${provider}`, built: false };
  };
  const pending = prebuildStartupImages(['daytona', 'platinum', 'e2b'], {
    default: build('default'), meta: build('meta'), pi: build('pi'),
    report: result => { results.push(result); },
  });
  try {
    expect(calls).toEqual([
      'default:daytona:startup', 'meta:daytona:startup', 'pi:daytona:startup',
      'default:platinum:startup', 'meta:platinum:startup',
      'default:e2b:startup', 'meta:e2b:startup',
    ]);
  } finally { release(); }
  await pending;
  expect(results).toHaveLength(7);
  expect(results).toContainEqual({ kind: 'pi', provider: 'daytona', snapshotName: 'pi-daytona', built: false });
  expect(results).toContainEqual({ kind: 'meta', provider: 'daytona', error: 'build unavailable' });
});

test('does not build Pi on an unavailable or unsupported provider', async () => {
  const calls: string[] = [];
  const build = async ({ provider }: { provider: string }) => {
    calls.push(provider);
    return { snapshotName: provider, built: true };
  };
  const builds = { default: build, meta: build, pi: async () => { throw new Error('unexpected Pi build'); }, report: () => {} };
  await prebuildStartupImages([], builds);
  expect(calls).toEqual([]);
  await prebuildStartupImages(['platinum'], builds);
  expect(calls).toEqual(['platinum', 'platinum']);
});
