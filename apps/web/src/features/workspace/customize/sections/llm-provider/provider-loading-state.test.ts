import { describe, expect, test } from 'bun:test';

import { isProviderStateLoading } from './provider-loading-state';

describe('isProviderStateLoading', () => {
  test('waits for project detail and project secrets', () => {
    expect(
      isProviderStateLoading({
        projectDetailLoading: true,
        secretsLoading: false,
      }),
    ).toBe(true);
    expect(
      isProviderStateLoading({
        projectDetailLoading: false,
        secretsLoading: true,
      }),
    ).toBe(true);
  });

  test('does not wait for runtime providers after BYOK state resolves', () => {
    expect(
      isProviderStateLoading({
        projectDetailLoading: false,
        secretsLoading: false,
      }),
    ).toBe(false);
  });

  // TanStack Query v5 resets a query with no data to `pending` on every
  // refetch. A member without project.secret.read gets 403 for the secrets
  // read; each remount refetched it, the spinner unmounted the provider list,
  // and the list remounted a reader of the same key: about 6 requests a second
  // (385 in 60 s) while the Models modal stayed a spinner.
  test('a refetch after the first answer never replaces the provider list with a spinner', () => {
    expect(
      isProviderStateLoading({
        projectDetailLoading: false,
        secretsLoading: true,
        secretsSettledOnce: true,
      }),
    ).toBe(false);
  });

  test('the first secrets read still waits', () => {
    expect(
      isProviderStateLoading({
        projectDetailLoading: false,
        secretsLoading: true,
        secretsSettledOnce: false,
      }),
    ).toBe(true);
  });
});
