import { afterEach, describe, expect, test } from 'bun:test';
import { configureKortix } from '@kortix/sdk';
import { qk } from '@kortix/sdk/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { accountStateKeys } from '../../billing/use-account-state';
import { useProjectCanRun } from './use-project-can-run';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

/**
 * The run gate behind Send, New session and voice calls needs the account
 * that owns the project. The project row (`GET /projects/:id`, one database
 * read) carries it. The detail (`GET /projects/:id/detail`) reads the
 * repository and can be slow: on 2026-11-04 a Send pressed while the detail
 * was pending sent nothing until the detail answered.
 */

configureKortix({ backendUrl: '', getToken: async () => null, billingEnabled: true });

const PROJECT = 'p1';
const ACCOUNT = 'acc-1';

let renderer: ReturnType<typeof create> | null = null;
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = null;
});

async function mountHook(queryClient: QueryClient) {
  let answer: ReturnType<typeof useProjectCanRun> | undefined;
  function Probe() {
    answer = useProjectCanRun(PROJECT);
    return null;
  }
  await act(async () => {
    renderer = create(createElement(QueryClientProvider, { client: queryClient }, createElement(Probe)));
  });
  return () => answer!;
}

describe('useProjectCanRun', () => {
  test('answers from the project row while the detail never settles', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(qk.project.summary(PROJECT), { project_id: PROJECT, account_id: ACCOUNT });
    queryClient.setQueryData(accountStateKeys.state(ACCOUNT), { billing_state: 'active' });
    void queryClient.prefetchQuery({ queryKey: qk.project.detail(PROJECT), queryFn: () => new Promise(() => {}) });

    const read = await mountHook(queryClient);

    expect(read()).toMatchObject({ isLoading: false, canRun: true, accountId: ACCOUNT, billingState: 'active' });
  });

  test('a blocked account is refused from the row alone', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(qk.project.summary(PROJECT), { project_id: PROJECT, account_id: ACCOUNT });
    queryClient.setQueryData(accountStateKeys.state(ACCOUNT), { billing_state: 'out_of_credits' });
    void queryClient.prefetchQuery({ queryKey: qk.project.detail(PROJECT), queryFn: () => new Promise(() => {}) });

    const read = await mountHook(queryClient);

    expect(read()).toMatchObject({ isLoading: false, canRun: false, accountId: ACCOUNT, billingState: 'out_of_credits' });
  });
});
