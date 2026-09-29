import { expect, mock, test } from 'bun:test';

const realReact = await import('react');

/**
 * Characterization: the live contract of `useDownloadRestriction`.
 *
 * The sole consumer (`FullScreenPresentationViewer`) reads exactly
 * `isRestricted` and `openUpgradeModal`. These tests pin that contract —
 * including the resolved-plan semantics behind `isFreeTier` (a stored
 * `tier_key: 'free'` on an admin trial stays unrestricted) — so the dead
 * wrapper, the unused `showUpgradePrompt` return key and the backward-compat
 * alias export can be deleted without touching what the consumer sees.
 */

const calls: string[] = [];
let accountState: Record<string, unknown> | null = null;
let billingEnabled = true;

mock.module('react', () => ({
  ...realReact,
  default: realReact.default,
  useCallback: (fn: unknown) => fn,
}));
mock.module('@/components/ui/toast', () => ({
  errorToast: (message: string, options: { description?: string; position?: string }) => {
    calls.push(`toast:${message}`);
    calls.push(`toast-desc:${options.description}`);
    calls.push(`toast-pos:${options.position}`);
  },
}));
mock.module('@/lib/config', () => ({ isBillingEnabled: () => billingEnabled }));
mock.module('@/stores/subscription-store', () => ({
  useSubscriptionStore: (selector: (state: { accountState: unknown }) => unknown) =>
    selector({ accountState }),
}));
mock.module('@/stores/upgrade-dialog-store', () => ({
  useUpgradeDialogStore: () => ({
    openUpgradeDialog: (opts: { reason: string; message: string }) =>
      calls.push(`dialog:${opts.reason}:${opts.message}`),
  }),
}));
mock.module('@/i18n/use-translations', () => ({
  useTranslations: () =>
    Object.assign(
      (key: string, params?: { value0?: string }) => `${key}:${params?.value0 ?? ''}`,
      { raw: (key: string) => key },
    ),
}));

const { useDownloadRestriction } = await import('./use-download-restriction');

const useRestrictedFlag = () => useDownloadRestriction({ featureName: 'presentations' }).isRestricted;

test('a free-family plan with billing enabled restricts downloads and openUpgradeModal toasts + opens the dialog', () => {
  accountState = { subscription: { tier_key: 'free' } };
  billingEnabled = true;
  expect(useRestrictedFlag()).toBe(true);

  const { openUpgradeModal } = useDownloadRestriction({ featureName: 'presentations' });
  calls.length = 0;
  openUpgradeModal();
  expect(calls).toEqual([
    'toast:texte2add2aa32a0:presentations',
    'toast-desc:text332f54c83d00',
    'toast-pos:top-center',
    'dialog:subscription_required:textc6c90c48b495:presentations',
  ]);
});

test('openUpgradeModal falls back to the "files" feature name', () => {
  accountState = { subscription: { tier_key: 'free' } };
  billingEnabled = true;
  const { openUpgradeModal } = useDownloadRestriction();
  calls.length = 0;
  openUpgradeModal();
  expect(calls[0]).toBe('toast:texte2add2aa32a0:files');
  expect(calls[3]).toBe('dialog:subscription_required:textc6c90c48b495:files');
});

test('a paid plan never restricts, even with billing enabled', () => {
  accountState = { plan: { family: 'team', label: 'Team' }, subscription: { tier_key: 'team' } };
  billingEnabled = true;
  expect(useRestrictedFlag()).toBe(false);
});

test('an admin trial (stored tier_key free, resolved plan paid) is not restricted', () => {
  accountState = { plan: { family: 'team', label: 'Team' }, subscription: { tier_key: 'free' } };
  billingEnabled = true;
  expect(useRestrictedFlag()).toBe(false);
});

test('billing disabled means no restriction, even on the free tier', () => {
  accountState = { subscription: { tier_key: 'free' } };
  billingEnabled = false;
  expect(useRestrictedFlag()).toBe(false);
});

test('no subscription state reads as unrestricted (the ?? false coercion)', () => {
  accountState = null;
  billingEnabled = true;
  expect(useRestrictedFlag()).toBe(false);
  accountState = { plan: { family: 'team', label: 'Team' } };
  expect(useRestrictedFlag()).toBe(false);
});
