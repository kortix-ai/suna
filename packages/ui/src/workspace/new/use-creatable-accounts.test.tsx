'use client';

// KRTX-4005 — `useCreatableAccounts` must fail CLOSED when the probe ERRORS.
// A settled error is not a grant: `canCreateInAccount` may fall back to the
// role only while the probe has NOT answered yet (KRTX-1700, a fresh owner's
// first render); after a persistent probe failure the account is not shown as
// creatable — the server stays the boundary either way.
//
// Harness: the real hook with a real `QueryClient` and the real SDK transport
// behind a recording `fetch` mock (same shape as
// `src/internal/lib/use-permission.test.tsx`).

import { describe, expect, test } from 'bun:test';
import { configureKortix } from '@kortix/sdk';
import type { KortixAccount } from '@kortix/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

type Mode = 'error' | 'pending' | { [accountId: string]: boolean };

async function renderCreatable(accounts: KortixAccount[], mode: Mode) {
  const { act, create } = await import('react-test-renderer');
  const { UiProvider } = await import('../../providers/ui-provider');
  const { useCreatableAccounts } = await import('./use-creatable-accounts');
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  // The transport needs an absolute backendUrl or `fetch` rejects the
  // relative URL before the mock is ever hit.
  configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
  const fetched: string[] = [];
  const realFetch = globalThis.fetch;
  // The hook's wire is the coalesced `effective:batch` POST (KRTX-4005); the
  // mock answers the batch shape for every probe. A regression back to single
  // GETs fails here — the single-probe shape would not parse — which is the
  // signal, not noise.
  //
  // Error mode answers 500, not 502/503/504: the transport retries transient
  // gateway statuses on reads with 250ms·2ⁿ backoff, and those retry timers
  // fire inside a LATER test's recording window through this shared global
  // mock — a cross-test flake unrelated to the hook. A 500 never retries
  // (TRANSIENT_GATEWAY_STATUSES in core/http/request.ts) and means the same
  // thing to the hook: the probe errored, fail closed.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    fetched.push(url);
    if (mode === 'error')
      return new Response(JSON.stringify({ error: 'unreachable' }), { status: 500 });
    if (mode === 'pending') return new Promise<Response>(() => {});
    const accountId = url.match(/\/accounts\/([^/]+)\//)?.[1] ?? '';
    const allowed = (mode as Record<string, boolean>)[accountId] === true;
    const body = init?.body
      ? (JSON.parse(String(init.body)) as { probes: Array<{ action: string }> })
      : { probes: [] };
    return new Response(
      JSON.stringify({
        results: body.probes.map((p) => ({
          allowed,
          reason: allowed ? 'role' : 'not_a_member',
          action: p.action,
          resource_type: 'account',
          resource_id: null,
        })),
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof fetch;

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const seen: { creatable?: KortixAccount[] } = {};
  function Probe() {
    seen.creatable = useCreatableAccounts(accounts);
    return null;
  }
  let root!: ReturnType<typeof create>;
  try {
    await act(async () => {
      root = create(
        <QueryClientProvider client={client}>
          <UiProvider config={{ accountApiEnabled: true }} useViewerId={() => 'u1'}>
            <Probe />
          </UiProvider>
        </QueryClientProvider>,
      );
    });
    // A second act flush: the probes settle asynchronously and the hook
    // re-renders with the settled verdicts.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
  } finally {
    await act(async () => root?.unmount());
    client.clear();
    globalThis.fetch = realFetch;
  }
  return { creatable: seen.creatable ?? [], fetched };
}

const owner: KortixAccount = { account_id: 'a1', name: 'Owner Co', account_role: 'owner' };
const member: KortixAccount = { account_id: 'a2', name: 'Member Co', account_role: 'member' };

describe('useCreatableAccounts — error handling (KRTX-4005)', () => {
  test('a persistent probe failure is fail-closed, even for an owner', async () => {
    const { creatable } = await renderCreatable([owner], 'error');
    expect(creatable).toEqual([]);
  });

  test('a probe that has not answered yet keeps the role fallback (KRTX-1700)', async () => {
    const { creatable } = await renderCreatable([owner, member], 'pending');
    expect(creatable.map((a) => a.account_id)).toEqual(['a1']);
  });

  test('the settled probe is the authority — a denied owner is not creatable', async () => {
    const { creatable } = await renderCreatable([owner], { a1: false });
    expect(creatable).toEqual([]);
  });

  test('a member granted project.create by a custom role is creatable', async () => {
    const { creatable } = await renderCreatable([member], { a2: true });
    expect(creatable.map((a) => a.account_id)).toEqual(['a2']);
  });

  test('one request per account, shared across the mount — no fan-out', async () => {
    const { fetched } = await renderCreatable([owner, member], { a1: true, a2: true });
    // One coalesced batch POST per account context — the two accounts are
    // distinct authorization contexts, so exactly two requests, no fan-out.
    expect(fetched).toHaveLength(2);
    expect(fetched.filter((u) => u.includes('/effective:batch'))).toHaveLength(2);
  });
});
