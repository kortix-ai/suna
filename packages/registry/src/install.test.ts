import { describe, expect, test } from 'bun:test';
import { hashContent } from './lock';
import { planInstall } from './install';
import type { ResolvedItem } from './fetch';
import type { RegistryItemFile } from './schema';

function filesOf(n: number): RegistryItemFile[] {
  return Array.from({ length: n }, (_, i) => ({
    path: `f${i}.md`,
    type: 'registry:file' as const,
    target: `~/f${i}.md`,
  }));
}

function multiFileItem(n: number, readFile: ResolvedItem['readFile']): ResolvedItem {
  return {
    ref: { kind: 'local', path: '.' },
    item: { name: 'multi', type: 'registry:skill', files: filesOf(n) },
    readFile,
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('planInstall — concurrent file reads', () => {
  test('reads for a multi-file item run concurrently, not one at a time', async () => {
    let active = 0;
    let maxActive = 0;
    const resolvers: Array<() => void> = [];
    const item = multiFileItem(5, (path) => {
      active++;
      maxActive = Math.max(maxActive, active);
      return new Promise((resolve) => {
        resolvers.push(() => {
          active--;
          resolve(`content of ${path}`);
        });
      });
    });

    const planPromise = planInstall(item, { configDir: '.kortix/opencode', exists: () => false });

    expect(resolvers.length).toBe(5);
    expect(maxActive).toBeGreaterThanOrEqual(2);

    for (const release of resolvers) release();
    const plan = await planPromise;
    expect(plan.writes.length).toBe(5);
  });

  test('never runs more than 8 reads at once, even with 20 files', async () => {
    let active = 0;
    let maxActive = 0;
    const resolvers: Array<() => void> = [];
    const item = multiFileItem(20, (path) => {
      active++;
      maxActive = Math.max(maxActive, active);
      return new Promise((resolve) => {
        resolvers.push(() => {
          active--;
          resolve(`content of ${path}`);
        });
      });
    });

    const planPromise = planInstall(item, { configDir: '.kortix/opencode', exists: () => false });
    expect(resolvers.length).toBe(8);

    let settled = 0;
    let iterations = 0;
    while (settled < 20 && iterations < 100) {
      while (settled < resolvers.length) {
        resolvers[settled]();
        settled++;
      }
      await flush();
      iterations++;
    }

    const plan = await planPromise;
    expect(plan.writes.length).toBe(20);
    expect(maxActive).toBeLessThanOrEqual(8);
    expect(maxActive).toBeGreaterThan(1);
  });

  test('output order and hashes match input file order (sequential-equivalent)', async () => {
    const contents = new Map([
      ['f0.md', 'zzz'],
      ['f1.md', 'aaa'],
      ['f2.md', 'mmm'],
      ['f3.md', 'bbb'],
    ]);
    const item = multiFileItem(4, async (path) => contents.get(path) ?? '');

    const plan = await planInstall(item, { configDir: '.kortix/opencode', exists: () => false });

    expect(plan.writes.map((w) => w.target)).toEqual(['f0.md', 'f1.md', 'f2.md', 'f3.md']);
    expect(plan.writes.map((w) => w.content)).toEqual(['zzz', 'aaa', 'mmm', 'bbb']);
    expect(plan.writes.map((w) => w.hash)).toEqual(['zzz', 'aaa', 'mmm', 'bbb'].map(hashContent));
  });

  test('a rejected read yields the exact warning text and skips only that file', async () => {
    const item: ResolvedItem = {
      ref: { kind: 'local', path: '.' },
      item: {
        name: 'partial',
        type: 'registry:skill',
        files: [
          { path: 'a.md', type: 'registry:file', target: '~/a.md' },
          { path: 'b.md', type: 'registry:file', target: '~/b.md' },
          { path: 'c.md', type: 'registry:file', target: '~/c.md' },
        ],
      },
      readFile: async (path) => {
        if (path === 'b.md') throw new Error('boom');
        return `content of ${path}`;
      },
    };

    const plan = await planInstall(item, { configDir: '.kortix/opencode', exists: () => false });

    expect(plan.warnings).toEqual(['could not read "b.md" for "partial": boom']);
    expect(plan.writes.map((w) => w.target)).toEqual(['a.md', 'c.md']);
    expect(plan.writes.map((w) => w.content)).toEqual(['content of a.md', 'content of c.md']);
  });
});
