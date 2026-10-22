/**
 * Characterization for the one default sandbox spec (KRTX-1534).
 *
 * templates.ts kept a private DEFAULT_CPU/DEFAULT_MEMORY_GB/DEFAULT_DISK_GB
 * copy with a 4 GiB memory fallback while build-context.ts exported the same
 * three names with a 6 GiB fallback, so the same env var answered a different
 * default depending on the code path. Commit 09168b832c moved the deliberate
 * default to 4 GiB (pricing: a 2 vCPU / 4 GiB / 20 GiB machine bills ~$0.10/h);
 * these tests lock that spec on both paths.
 */
import { describe, expect, mock, test } from 'bun:test';

// Every awaited DB query answers from this queue, in call order.
const answers: unknown[][] = [];
function query(): unknown {
  const chain: unknown = new Proxy(() => {}, {
    get: (_target, key) =>
      key === 'then'
        ? (resolve: (rows: unknown[]) => void) => resolve(answers.shift() ?? [])
        : key === 'catch'
          ? () => Promise.resolve(answers.shift() ?? [])
          : () => chain,
    apply: () => chain,
  });
  return chain;
}
mock.module('../shared/db', () => ({ db: query() }));

const { resolveDefaultTemplate } = await import('./templates');
const { DEFAULT_CPU, DEFAULT_DISK_GB, DEFAULT_MEMORY_GB } = await import('./build-context');

describe('the default sandbox spec is one definition with one memory fallback', () => {
  test('the provider no-spec fallback (build-context) resolves the agreed 4 GiB', () => {
    expect(DEFAULT_CPU).toBe(2);
    expect(DEFAULT_MEMORY_GB).toBe(4);
    expect(DEFAULT_DISK_GB).toBe(20);
  });

  test('the synthesized platform default (no template rows) resolves the same spec', async () => {
    answers.push([]); // resolveDefaultTemplate: no shared row
    const tpl = await resolveDefaultTemplate();
    expect(tpl.cpu).toBe(2);
    expect(tpl.memoryGb).toBe(4);
    expect(tpl.diskGb).toBe(20);
  });

  test('a template row with NULL resources falls back to the same spec', async () => {
    answers.push([
      {
        templateId: 'tpl-null-spec',
        projectId: null,
        slug: 'default',
        name: 'Default',
        isShared: true,
        source: 'platform',
        provider: 'daytona',
        image: null,
        dockerfilePath: null,
        entrypoint: null,
        cpu: null,
        memoryGb: null,
        diskGb: null,
        containerRuntime: false,
        providerState: 'missing',
        providerSnapshotName: null,
        contentHash: null,
        builtFromCommit: null,
        swapKey: null,
        createdAt: new Date(),
      },
    ]);
    const tpl = await resolveDefaultTemplate();
    expect(tpl.cpu).toBe(2);
    expect(tpl.memoryGb).toBe(4);
    expect(tpl.diskGb).toBe(20);
  });
});
