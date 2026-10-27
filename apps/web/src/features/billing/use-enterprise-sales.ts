'use client';

/**
 * The two in-app Enterprise actions, with their toasts
 * (.agents/skills/billing/references/plans-and-access.md, "Enterprise"):
 *
 * - `useTalkToSales`: one click emails Kortix sales the account, the user and
 *   its Enterprise state. No form: a signed-in user already told us who they are.
 * - `useEnterpriseDemo`: an owner or admin turns the Enterprise demo on or off.
 */

import { errorToast, successToast } from '@kortix/ui/toast';
import { useTranslations } from '@/i18n/use-translations';
import { useContactSales, useSetEnterpriseDemo } from '@kortix/sdk/react';

export function useTalkToSales(accountId: string | undefined) {
  const t = useTranslations('billing.access');
  const contact = useContactSales();
  const talk = () =>
    contact.mutate(
      { accountId },
      {
        // `sent: false`: the deployment has no sales inbox. Nobody was told.
        onSuccess: ({ sent }) => (sent ? successToast(t('salesSent')) : errorToast(t('salesFailed'))),
        onError: (error) => errorToast(t('salesFailed'), { description: error.message }),
      },
    );
  return { talk, isPending: contact.isPending };
}

export function useEnterpriseDemo(accountId: string | undefined) {
  const t = useTranslations('billing.access');
  const setDemo = useSetEnterpriseDemo();
  const set = (enabled: boolean) => {
    if (!accountId) return;
    setDemo.mutate(
      { accountId, enabled },
      {
        onSuccess: () => successToast(enabled ? t('demoOnToast') : t('demoOffToast')),
        onError: (error) => errorToast(t('demoFailed'), { description: error.message }),
      },
    );
  };
  return { set, isPending: setDemo.isPending };
}
