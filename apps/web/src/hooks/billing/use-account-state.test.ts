import { describe, expect, mock, test } from 'bun:test';

const calls: string[] = [];
let mutation: Record<string, (...args: any[]) => any>;
const queryClient = { invalidateQueries: ({ queryKey }: { queryKey: unknown }) => calls.push(JSON.stringify(queryKey)), refetchQueries: () => Promise.resolve() };

mock.module('@/i18n/use-translations', () => ({ useTranslations: () => Object.assign((key: string) => key, { raw: (key: string) => key }) }));
mock.module('@/components/ui/toast', () => ({ successToast: (message: string) => calls.push(`success:${message}`), errorToast: (message: string) => calls.push(`error:${message}`), infoToast: () => {} }));
mock.module('@/stores/billing-account-context', () => ({ useBillingAccountId: () => 'synthetic-account', useBillingAccountResolved: () => true }));
mock.module('@tanstack/react-query', () => ({ useMutation: (options: typeof mutation) => { mutation = options; return options; }, useQuery: () => ({}), useQueryClient: () => queryClient }));

const hooks = await import('./use-account-state');

describe('billing mutation callback contract', () => {
  for (const [name, hook, failureKey] of [
    ['cancel', hooks.useCancelSubscription, 'text2b41749fceaa'],
    ['reactivate', hooks.useReactivateSubscription, 'text5051e9e23edf'],
    ['schedule', hooks.useScheduleDowngrade, 'text645418722dbb'],
    ['cancel scheduled', hooks.useCancelScheduledChange, 'text9118f944fba6'],
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
