import { describe, expect, mock, test } from 'bun:test';

const calls: string[] = [];
let mutation: Record<string, (...args: any[]) => any>;
const queryClient = { invalidateQueries: ({ queryKey }: { queryKey: unknown }) => calls.push(JSON.stringify(queryKey)), refetchQueries: () => Promise.resolve() };

mock.module('@/i18n/use-translations', () => ({ useTranslations: () => Object.assign((key: string) => key, { raw: (key: string) => key }) }));
mock.module('@/components/ui/toast', () => ({ successToast: (message: string) => calls.push(`success:${message}`), errorToast: (message: string) => calls.push(`error:${message}`), infoToast: () => {} }));
mock.module('@/stores/billing-account-context', () => ({ useBillingAccountId: () => 'synthetic-account', useBillingAccountResolved: () => true }));
mock.module('@tanstack/react-query', () => ({ useMutation: (options: typeof mutation) => { mutation = options; return options; }, useQuery: () => ({}), useQueryClient: () => queryClient }));

/** Every forced fetch, in order; `fetchImpl` decides how each one settles. */
const fetched: Array<{ skipCache?: boolean; accountId?: string }> = [];
let fetchImpl: (options: { skipCache?: boolean; accountId?: string }) => Promise<unknown> = async (options) => ({ account: options.accountId });
const realSdk = await import('@kortix/sdk');
mock.module('@kortix/sdk', () => ({
  ...realSdk,
  getAccountState: (options: { skipCache?: boolean; accountId?: string }) => {
    fetched.push(options);
    return fetchImpl(options);
  },
}));

const hooks = await import('./use-account-state');

describe('billing mutation callback contract', () => {
  for (const [name, hook, failureKey] of [
    ['cancel', hooks.useCancelSubscription, 'text2b41749fceaa'],
    ['reactivate', hooks.useReactivateSubscription, 'text5051e9e23edf'],
  ] as const) {
    test(`${name}: invalidates and reports both response outcomes and errors`, () => {
      hook();
      calls.length = 0;
      mutation.onSuccess({ success: true, message: 'ok' });
      expect(calls).toEqual(['["account-state","state",{"accountId":"synthetic-account"}]', '["account-state","state",{"accountId":null}]', 'success:ok']);
      calls.length = 0;
      mutation.onSuccess({ success: false, message: 'denied' });
      expect(calls.at(-1)).toBe('error:denied');
      mutation.onError(new Error('broken'));
      mutation.onError({});
      expect(calls.slice(-2)).toEqual(['error:broken', `error:${failureKey}`]);
    });
  }

  test('sync invalidates without a forced refetch and uses its translated success/error messages', () => {
    hooks.useSyncSubscription();
    calls.length = 0;
    mutation.onSuccess();
    expect(calls).toEqual(['["account-state","state",{"accountId":"synthetic-account"}]', '["account-state","state",{"accountId":null}]', 'success:text24db9f4eb779']);
    mutation.onError({});
    expect(calls.at(-1)).toBe('error:textf3d331b82d30');
  });
});

/** A QueryClient that records what the forced refresh wrote and refetched. */
function recordingClient() {
  const written: string[] = [];
  const refetched: string[] = [];
  return {
    written,
    refetched,
    client: {
      invalidateQueries: () => undefined,
      refetchQueries: async ({ queryKey }: { queryKey: unknown }) => {
        refetched.push(JSON.stringify(queryKey));
      },
      setQueryData: (queryKey: unknown) => {
        written.push(JSON.stringify(queryKey));
      },
    } as never,
  };
}

const afterDebounce = () => new Promise((resolve) => setTimeout(resolve, 260));
const slot = (accountId: string) => JSON.stringify(['account-state', 'state', { accountId }]);

describe('forced account-state refreshes stay per QueryClient and account (KRTX-2414)', () => {
  test('two accounts forced within one debounce window both fetch, each into its own slot', async () => {
    fetched.length = 0;
    const { client, written } = recordingClient();
    hooks.invalidateAccountState(client, true, true, 'account-a');
    hooks.invalidateAccountState(client, true, true, 'account-b');
    await afterDebounce();
    expect(fetched.map((call) => call.accountId).sort()).toEqual(['account-a', 'account-b']);
    expect(written.sort()).toEqual([slot('account-a'), slot('account-b')]);
  });

  test('an account forced while another account is still fetching gets its own fetch', async () => {
    fetched.length = 0;
    let releaseA: () => void = () => undefined;
    fetchImpl = (options) =>
      options.accountId === 'account-c' ? new Promise((resolve) => { releaseA = () => resolve({}); }) : Promise.resolve({});
    const { client, written } = recordingClient();
    hooks.invalidateAccountState(client, true, true, 'account-c');
    await afterDebounce();
    hooks.invalidateAccountState(client, true, true, 'account-d');
    await afterDebounce();
    expect(written).toEqual([slot('account-d')]);
    releaseA();
    await afterDebounce();
    expect(written.sort()).toEqual([slot('account-c'), slot('account-d')]);
    fetchImpl = async () => ({});
  });

  test('two QueryClients forcing the same account do not suppress each other', async () => {
    fetched.length = 0;
    const first = recordingClient();
    const second = recordingClient();
    hooks.invalidateAccountState(first.client, true, true, 'account-e');
    hooks.invalidateAccountState(second.client, true, true, 'account-e');
    await afterDebounce();
    expect(fetched).toHaveLength(2);
    expect(first.written).toEqual([slot('account-e')]);
    expect(second.written).toEqual([slot('account-e')]);
  });

  test('one account forced twice in a window fetches once, and a skipCache request wins', async () => {
    fetched.length = 0;
    const { client, written, refetched } = recordingClient();
    hooks.invalidateAccountState(client, true, false, 'account-f');
    hooks.invalidateAccountState(client, true, true, 'account-f');
    await afterDebounce();
    expect(fetched).toEqual([{ skipCache: true, accountId: 'account-f' }]);
    expect(written).toEqual([slot('account-f')]);
    expect(refetched).toEqual([]);
  });

  test('a failed forced fetch raises no unhandled rejection, and the next request fetches again', async () => {
    fetched.length = 0;
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    fetchImpl = async () => {
      throw new Error('billing unavailable');
    };
    const { client, written } = recordingClient();
    hooks.invalidateAccountState(client, true, true, 'account-g');
    await afterDebounce();
    fetchImpl = async () => ({});
    hooks.invalidateAccountState(client, true, true, 'account-g');
    await afterDebounce();
    process.off('unhandledRejection', onUnhandled);
    expect(unhandled).toEqual([]);
    expect(fetched).toHaveLength(2);
    expect(written).toEqual([slot('account-g')]);
  });
});
