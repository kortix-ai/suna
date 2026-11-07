import { describe, expect, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';

import { resetRuntimeQueries, runtimeKeys } from './keys';

describe('runtime query keys', () => {
  test('scopes a repeated runtime session id to its sandbox runtime', () => {
    expect(runtimeKeys.runtimeSession('ses_shared', 'sandbox-a')).not.toEqual(
      runtimeKeys.runtimeSession('ses_shared', 'sandbox-b'),
    );
    expect(runtimeKeys.runtimeMessages('ses_shared', 'sandbox-a')).not.toEqual(
      runtimeKeys.runtimeMessages('ses_shared', 'sandbox-b'),
    );
  });

  test('keeps the runtime scope at the end for prefix invalidation compatibility', () => {
    expect(runtimeKeys.runtimeSession('ses_1', 'sandbox-a')).toEqual([
      'runtime',
      'session',
      'ses_1',
      'sandbox-a',
    ]);
    expect(runtimeKeys.runtimeMessages('ses_1', 'sandbox-a')).toEqual([
      'runtime',
      'session',
      'ses_1',
      'messages',
      'sandbox-a',
    ]);
  });

  test('every runtime key sits under the one `runtime` root that resetRuntimeQueries removes', () => {
    expect(runtimeKeys.all).toEqual(['runtime']);
    expect(runtimeKeys.session('ses_1')).toEqual(['runtime', 'session', 'ses_1']);
    expect(runtimeKeys.messages('ses_1')).toEqual(['runtime', 'session', 'ses_1', 'messages']);
  });
});

describe('runtimeKeys.sessionTodo', () => {
  test('is the key the todo hook and the event stream write', () => {
    expect(runtimeKeys.sessionTodo('ses_1')).toEqual(['runtime', 'session-todo', 'ses_1']);
  });
});

describe('resetRuntimeQueries', () => {
  test('removes every runtime query and leaves every other cache entry alone', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(runtimeKeys.runtimeMessages('ses_1', 'sandbox-a'), ['message']);
    queryClient.setQueryData(runtimeKeys.agents(), ['agent']);
    queryClient.setQueryData(runtimeKeys.vcsDiff('branch', 'sandbox-a'), ['diff']);
    queryClient.setQueryData(['host-owned'], ['kept']);

    resetRuntimeQueries(queryClient);

    expect(queryClient.getQueryCache().getAll().map((query) => query.queryKey)).toEqual([['host-owned']]);
  });
});
