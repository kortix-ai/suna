import { describe, expect, it, vi } from 'vitest';
import { ResourceStack } from '../src/fixtures/registry';

describe('ResourceStack cleanup verification', () => {
  it('reports a failed project purge after attempting every tracked deletion', async () => {
    const del = vi
      .fn()
      .mockResolvedValueOnce({ statusCode: 503, text: () => 'git host unavailable' })
      .mockResolvedValueOnce({ statusCode: 200, text: () => '{"ok":true}' });
    const stack = new ResourceStack({ del } as any);
    stack.push('project', 'source-project');
    stack.push('project', 'derived-project');

    await expect(stack.teardown({ throwOnFailure: true })).rejects.toThrow(
      'cleanup failed for 1 resource',
    );
    expect(del).toHaveBeenCalledTimes(2);
  });

  it('accepts an already-deleted resource during strict cleanup', async () => {
    const del = vi.fn().mockResolvedValue({ statusCode: 404, text: () => 'not found' });
    const stack = new ResourceStack({ del } as any);
    stack.push('project', 'missing-project');

    await expect(stack.teardown({ throwOnFailure: true })).resolves.toBeUndefined();
  });
});
