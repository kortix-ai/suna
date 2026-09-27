import { describe, expect, test } from 'bun:test';
import { qk } from '@kortix/sdk/react';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import {
  forgetSubscriptionCredentials,
  subscriptionIsConnected,
  subscriptionPrimaryAction,
} from './subscription-control';

describe('subscriptionIsConnected', () => {
  test('sees the current credential', () => {
    expect(subscriptionIsConnected(['CODEX_AUTH_JSON'])).toBe(true);
  });

  // Projects connected before the rename still hold the legacy name, and they
  // are exactly the long-lived ones a user would now be trying to disconnect.
  test('sees the legacy credential', () => {
    expect(subscriptionIsConnected(['OPENCODE_AUTH_JSON'])).toBe(true);
  });

  test('an API key alone is NOT a subscription', () => {
    expect(subscriptionIsConnected(['OPENAI_API_KEY'])).toBe(false);
    expect(subscriptionIsConnected([])).toBe(false);
  });
});

describe('subscriptionPrimaryAction', () => {
  // The defect: a connected subscription offered "Connect" forever and could
  // never be removed from any surface in the product.
  test('a connected subscription offers DISCONNECT', () => {
    expect(subscriptionPrimaryAction({ connected: true, failed: false })).toBe('disconnect');
  });

  test('nothing connected offers CONNECT', () => {
    expect(subscriptionPrimaryAction({ connected: false, failed: false })).toBe('connect');
  });

  test('a failed attempt offers RECONNECT even when a credential is on file', () => {
    expect(subscriptionPrimaryAction({ connected: true, failed: true })).toBe('reconnect');
    expect(subscriptionPrimaryAction({ connected: false, failed: true })).toBe('reconnect');
  });
});

// THE DEFECT this covers: "Disconnect ChatGPT" returned 200 and the card kept
// its green "connected" banner and its Disconnect button. The card derived
// `connected` only from a refetch of `GET /secrets`, which loads the project
// manifest on every call and was cancelled by each follow-up refresh pass. The
// server already confirmed the delete, so the cache must say so at once.
describe('forgetSubscriptionCredentials', () => {
  const PROJECT_ID = 'proj_1';
  const key = qk.project.secrets(PROJECT_ID);
  const row = (name: string) => ({ identifier: name, name, project_id: PROJECT_ID });

  test('the card reads disconnected as soon as the delete succeeds', async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(key, {
      items: [row('CODEX_AUTH_JSON'), row('OPENCODE_AUTH_JSON'), row('OPENAI_API_KEY')],
      required: [],
      optional: [],
    });

    await forgetSubscriptionCredentials(queryClient, PROJECT_ID);

    const data = queryClient.getQueryData<{ items: Array<{ name: string }> }>(key);
    expect(data?.items.map((item) => item.name)).toEqual(['OPENAI_API_KEY']);
    expect(subscriptionIsConnected(data!.items.map((item) => item.name))).toBe(false);
  });

  test('keeps the array cache shape other readers write', async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(key, [row('CODEX_AUTH_JSON'), row('STRIPE_API_KEY')]);

    await forgetSubscriptionCredentials(queryClient, PROJECT_ID);

    expect(queryClient.getQueryData(key)).toEqual([row('STRIPE_API_KEY')]);
  });

  test('a read started before the delete cannot restore the credential', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(key, { items: [row('CODEX_AUTH_JSON')] });
    let resolvePreWriteRead: (value: unknown) => void = () => {};
    const observer = new QueryObserver(queryClient, {
      queryKey: key,
      queryFn: () => new Promise((resolve) => (resolvePreWriteRead = resolve)),
      staleTime: 60_000,
    });
    const unsubscribe = observer.subscribe(() => {});
    void queryClient.refetchQueries({ queryKey: key });

    await forgetSubscriptionCredentials(queryClient, PROJECT_ID);
    resolvePreWriteRead({ items: [row('CODEX_AUTH_JSON')] });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(queryClient.getQueryData(key)).toEqual({ items: [] });
    unsubscribe();
  });

  test('an empty cache stays empty', async () => {
    const queryClient = new QueryClient();

    await forgetSubscriptionCredentials(queryClient, PROJECT_ID);

    expect(queryClient.getQueryData(key)).toBeUndefined();
  });
});
