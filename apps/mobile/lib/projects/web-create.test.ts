import { describe, expect, test } from 'bun:test';

import { addedAccount, createWebCreateRunner, newestAddedProject, newestProject } from './web-create';

const p = (project_id: string, created_at: string) => ({ project_id, created_at });

describe('newestProject', () => {
  test('the most recently created project, or null', () => {
    expect(newestProject([])).toBeNull();
    expect(newestProject([p('old', '2026-09-01T00:00:00Z'), p('new', '2026-09-24T00:00:00Z')])?.project_id).toBe('new');
  });
});

describe('newestAddedProject', () => {
  test('null when nothing was added', () => {
    expect(newestAddedProject(['a', 'b'], [p('a', '2026-09-01T00:00:00Z'), p('b', '2026-09-02T00:00:00Z')])).toBeNull();
  });

  test('the project that did not exist before', () => {
    expect(
      newestAddedProject(['a'], [p('a', '2026-09-25T00:00:00Z'), p('c', '2026-09-24T00:00:00Z')])?.project_id
    ).toBe('c');
  });

  test('the newest of several added projects, never an older existing one', () => {
    const after = [p('a', '2026-09-26T00:00:00Z'), p('b', '2026-09-24T00:00:00Z'), p('c', '2026-09-25T00:00:00Z')];
    expect(newestAddedProject(['a'], after)?.project_id).toBe('c');
  });

  test('every project is added when there was none before (first run)', () => {
    expect(newestAddedProject([], [p('a', '2026-09-24T00:00:00Z')])?.project_id).toBe('a');
  });

  test('a removed project is not an addition', () => {
    expect(newestAddedProject(['a', 'b'], [p('a', '2026-09-24T00:00:00Z')])).toBeNull();
  });
});

describe('addedAccount', () => {
  test('the account that did not exist before, or null', () => {
    expect(addedAccount(['x'], [{ account_id: 'x' }])).toBeNull();
    expect(addedAccount(['x'], [{ account_id: 'x' }, { account_id: 'y' }])?.account_id).toBe('y');
  });
});

describe('createWebCreateRunner', () => {
  const acc = (account_id: string) => ({ account_id });
  type Snap = { accounts: { account_id: string }[]; projects: { project_id: string; created_at: string }[] };
  const before: Snap = { accounts: [acc('x')], projects: [p('a', '2026-09-20T00:00:00Z')] };
  const after: Snap = {
    accounts: [acc('x'), acc('y')],
    projects: [p('a', '2026-09-20T00:00:00Z'), p('b', '2026-09-25T00:00:00Z')],
  };

  function harness(opts: { snapshots: (Snap | Error)[]; browserFails?: boolean }) {
    const calls: string[] = [];
    const pendings: boolean[] = [];
    let browserDone!: () => void;
    const queue = [...opts.snapshots];
    const runner = createWebCreateRunner<{ account_id: string }, { project_id: string; created_at: string }>({
      fetchSnapshot: async () => {
        calls.push('snapshot');
        const next = queue.shift();
        if (!next || next instanceof Error) throw next ?? new Error('none');
        return next;
      },
      openBrowser: (url) => {
        calls.push(`open ${url}`);
        if (opts.browserFails) return Promise.reject(new Error('no browser'));
        return new Promise<void>((resolve) => {
          browserDone = () => {
            calls.push('closed');
            resolve();
          };
        });
      },
      invalidate: () => {
        calls.push('invalidate');
      },
      onPendingChange: (pending) => pendings.push(pending),
    });
    return { runner, calls, pendings, close: () => browserDone() };
  }

  const tick = () => new Promise((r) => setTimeout(r, 0));

  test('snapshot → browser → before awaited → invalidate → after; diffs', async () => {
    const h = harness({ snapshots: [before, after] });
    const result = h.runner.run('u');
    await tick();
    h.close();
    const out = await result;
    expect(h.calls).toEqual(['snapshot', 'open u', 'closed', 'invalidate', 'snapshot']);
    expect(out.project?.project_id).toBe('b');
    expect(out.account?.account_id).toBe('y');
    expect(out.after).toEqual(after);
    expect(h.pendings).toEqual([true, false]);
  });

  test('a failed before-snapshot turns off the diff but still returns the after lists', async () => {
    const h = harness({ snapshots: [new Error('offline'), after] });
    const result = h.runner.run('u');
    await tick();
    h.close();
    const out = await result;
    expect(out.project).toBeNull();
    expect(out.account).toBeNull();
    expect(out.after).toEqual(after);
    // First run opens the newest project across every account from `after`.
    expect(newestProject(out.after!.projects)?.project_id).toBe('b');
  });

  test('a browser that fails to open returns nothing and never invalidates', async () => {
    const h = harness({ snapshots: [before, after], browserFails: true });
    const out = await h.runner.run('u');
    expect(out).toEqual({ project: null, account: null, after: null });
    expect(h.calls).not.toContain('invalidate');
    expect(h.pendings).toEqual([true, false]);
  });

  test('a second run while one is in flight does nothing', async () => {
    const h = harness({ snapshots: [before, after] });
    const first = h.runner.run('u');
    expect(h.runner.isPending()).toBe(true);
    const second = await h.runner.run('v');
    expect(second).toEqual({ project: null, account: null, after: null });
    await tick();
    h.close();
    await first;
    expect(h.calls.filter((c) => c.startsWith('open'))).toEqual(['open u']);
    expect(h.runner.isPending()).toBe(false);
  });
});
