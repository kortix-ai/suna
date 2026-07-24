import { describe, expect, it, vi } from 'vitest';
import { RunRepositoryPool } from '../src/fixtures/repository-pool';

describe('RunRepositoryPool', () => {
  it('creates one managed repository and one isolated branch per project', async () => {
    const provision = vi.fn().mockResolvedValue({
      project: { id: 'pool-project', name: 'pool' },
    });
    const registerProject = vi
      .fn()
      .mockResolvedValueOnce({ id: 'project-1', name: 'one' })
      .mockResolvedValueOnce({ id: 'project-2', name: 'two' });
    const pool = new RunRepositoryPool('run-123', {
      provision,
      registerProject,
    });

    const [first, second, shared] = await Promise.all([
      pool.project({ name: 'one', accountId: 'account-1' }),
      pool.project({ name: 'two', accountId: 'account-2' }),
      pool.sharedProject(),
    ]);

    expect(provision).toHaveBeenCalledTimes(1);
    expect(shared.id).toBe('pool-project');
    expect([first.id, second.id]).toEqual(['project-1', 'project-2']);
    expect(registerProject.mock.calls.map(([input]) => input.accountId)).toEqual([
      'account-1',
      'account-2',
    ]);
    expect(registerProject.mock.calls.map(([input]) => input.branch)).toEqual([
      'ke2e-run-123-1',
      'ke2e-run-123-2',
    ]);
    expect(registerProject.mock.calls.map(([input]) => input.sourceProjectId)).toEqual([
      'pool-project',
      'pool-project',
    ]);
  });

  it('does not provision a repository until a project fixture needs one', () => {
    const provision = vi.fn();
    new RunRepositoryPool('run-123', {
      provision,
      registerProject: vi.fn(),
    });

    expect(provision).not.toHaveBeenCalled();
  });
});
