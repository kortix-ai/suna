import { describe, expect, mock, test } from 'bun:test';
import { MutationObserver, QueryClient } from '@tanstack/react-query';

/**
 * Regression coverage for the "Failed to perform action: not found" toast
 * bug (reported firing near the chat composer / approval prompt, seemingly
 * at random).
 *
 * Root cause: `resolveApprovalMutationOptions` (used by `useResolveApproval`)
 * had no hook-level `onError`. Every call site
 * (`SessionApprovalPrompt`, `SessionAuditPanel`,
 * `SessionPendingApprovalsIndicator`) already passes its own call-time
 * `onError` to `resolve.mutate(vars, { onError })` for a specific, actionable
 * toast — but TanStack Query's `defaultMutationOptions()` does a plain
 * `{...defaultOptions.mutations, ...hookOptions}` merge
 * (`node_modules/@tanstack/query-core/.../queryClient.js`). Since the hook
 * didn't set its own `onError`, the merge fell through to the QueryClient's
 * global default mutation `onError`
 * (`apps/web/src/app/react-query-provider.tsx`), which ALSO fires — in
 * addition to, not instead of, the call-time one
 * (`query-core/build/modern/mutation.js`: `this.options.onError` fires from
 * `Mutation.execute()` independently of the `MutationObserver`-level
 * call-time callbacks). That produced a confusing second toast — the global
 * default's generic "Failed to <operation>: <message>" — most visibly when
 * the resolve endpoint 404s with a bare "not found" (e.g. the target
 * execution was already resolved elsewhere before the audit poll caught up;
 * `apps/api` allows resolving with zero browsers open — see
 * `session-chat.tsx`'s note on server-side `continueSession` delivery).
 *
 * This test drives the REAL exported mutation options through a real
 * `MutationObserver` against a `QueryClient` configured exactly like
 * `react-query-provider.tsx`'s global default, so it fails if the
 * hook-level `onError: () => {}` opt-out is ever removed.
 */

const resolveApprovalMock = mock(async () => {
  throw new Error('not found');
});

mock.module('@kortix/sdk/projects-client', () => ({
  getSessionAudit: mock(async () => ({ actions: [] })),
  listSessionsNeedingInput: mock(async () => ({ sessions: {}, total: 0 })),
  resolveApproval: resolveApprovalMock,
}));

const { resolveApprovalMutationOptions } = await import('./session-audit-shared');

/** Mirrors `apps/web/src/app/react-query-provider.tsx`'s global default
 *  mutation `onError` shape closely enough to prove (or disprove) that it
 *  fires — the exact toast text isn't the point, just whether the global
 *  default handler runs at all for a given mutation. */
function queryClientWithGlobalDefault(onGlobalError: (error: unknown) => void) {
  return new QueryClient({
    defaultOptions: {
      mutations: {
        onError: onGlobalError,
      },
    },
  });
}

describe('resolveApprovalMutationOptions', () => {
  test('opts out of the QueryClient global default mutation onError', async () => {
    const globalErrors: unknown[] = [];
    const callSiteErrors: unknown[] = [];
    const queryClient = queryClientWithGlobalDefault((e) => globalErrors.push(e));

    const options = resolveApprovalMutationOptions('proj-1', 'session-1', queryClient);
    const observer = new MutationObserver(queryClient, options);
    // `useMutation()` subscribes internally via `useSyncExternalStore` — a
    // live subscriber is required for the MutationObserver's call-time
    // (`.mutate(vars, { onError })`) callbacks to fire at all.
    const unsubscribe = observer.subscribe(() => {});

    await observer
      .mutate(
        { executionId: 'exec-1', decision: 'approve' },
        {
          onError: (e) => callSiteErrors.push(e),
        },
      )
      .catch(() => {
        // The mutation is expected to reject — the call-site (and, if the
        // fix regresses, the global default) handles it via callbacks.
      });

    unsubscribe();

    // The call site's own error handling still runs — this hook must keep
    // that working.
    expect(callSiteErrors).toHaveLength(1);
    expect((callSiteErrors[0] as Error).message).toBe('not found');

    // The QueryClient's global default onError must NOT also fire — that
    // extra, generic "Failed to perform action: not found" toast is exactly
    // the reported bug.
    expect(globalErrors).toHaveLength(0);
  });

  test('still invalidates the shared audit query on settle after a failed resolve', async () => {
    const queryClient = queryClientWithGlobalDefault(() => {});
    const invalidateSpy = mock(() => Promise.resolve());
    queryClient.invalidateQueries = invalidateSpy as typeof queryClient.invalidateQueries;

    const options = resolveApprovalMutationOptions('proj-1', 'session-1', queryClient);
    const observer = new MutationObserver(queryClient, options);
    const unsubscribe = observer.subscribe(() => {});

    await observer.mutate({ executionId: 'exec-1', decision: 'deny' }).catch(() => {});

    unsubscribe();

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['session-audit', 'proj-1', 'session-1'],
    });
  });
});
