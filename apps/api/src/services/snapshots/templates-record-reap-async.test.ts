import { describe, expect, mock, test } from 'bun:test';

// recordTemplateBuilt must not make its caller wait for the predecessor reap.
// The first session after each Kortix deploy lands here (the release gate builds
// the new image unpublished), and on 2026-10-02 the reap's provider lookup walked
// 34 pages of templates inside that session's `image:resolved` (8.7 s).

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
mock.module('../../lib/db', () => ({ db: query() }));

let releaseDelete: () => void = () => {};
const deleted: string[] = [];
mock.module('./providers', () => ({
  getSandboxProvider: () => ({
    deleteSnapshot: (name: string) =>
      new Promise<void>((resolve) => {
        releaseDelete = () => {
          deleted.push(name);
          resolve();
        };
      }),
  }),
}));

const { recordTemplateBuilt, settlePredecessorReapsForTests } = await import('./templates');

describe('recordTemplateBuilt reaps the predecessor off the caller path', () => {
  test('returns while the provider delete is still pending, then the reap completes', async () => {
    answers.push(
      [{ templateId: 'tpl', providerSnapshotName: 'kortix-default-old', provider: 'platinum' }], // getTemplateById
      [], // update … set … where (repoint)
      [], // still referenced by another row? no
    );
    let returned = false;
    await recordTemplateBuilt('tpl', {
      snapshotName: 'kortix-default-new',
      contentHash: 'h',
      provider: 'platinum',
    }).then(() => {
      returned = true;
    });
    expect(returned).toBe(true);
    expect(deleted).toEqual([]); // the delete has not finished, yet the caller already moved on
    // Let the reap reach the provider, then release it.
    for (let i = 0; i < 20 && deleted.length === 0; i++) {
      releaseDelete();
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    await settlePredecessorReapsForTests();
    expect(deleted).toEqual(['kortix-default-old']);
  });
});
