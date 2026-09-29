import { beforeEach, describe, expect, mock, test } from 'bun:test';

import {
  SubscriptionStoreSync,
  useSubscriptionStore,
  useSubscriptionStoreSync,
} from './subscription-store';

describe('subscription store', () => {
  beforeEach(() => {
    useSubscriptionStore.setState({
      accountState: null,
      isLoading: false,
      error: null,
      _refetchAccountState: undefined,
    });
  });

  test('the live surface stays exported', () => {
    expect(typeof useSubscriptionStore).toBe('function');
    expect(typeof useSubscriptionStoreSync).toBe('function');
    expect(typeof SubscriptionStoreSync).toBe('function');
  });

  test('setAccountState, setLoading and setError update the store', () => {
    const error = new Error('billing unavailable');
    const accountState = { subscription: null } as never;

    useSubscriptionStore.getState().setAccountState(accountState);
    useSubscriptionStore.getState().setLoading(true);
    useSubscriptionStore.getState().setError(error);

    const state = useSubscriptionStore.getState();
    expect(state.accountState).toBe(accountState);
    expect(state.isLoading).toBe(true);
    expect(state.error).toBe(error);
  });

  test('refetch invokes the registered callback', () => {
    const refetchAccountState = mock(() => {});
    useSubscriptionStore.getState().setRefetchCallback(refetchAccountState);
    useSubscriptionStore.getState().refetch();
    expect(refetchAccountState).toHaveBeenCalledTimes(1);
  });

  test('refetch with no registered callback is a no-op', () => {
    expect(() => useSubscriptionStore.getState().refetch()).not.toThrow();
  });
});
