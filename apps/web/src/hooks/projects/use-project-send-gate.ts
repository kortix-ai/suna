'use client';

import { useCallback } from 'react';

import { usePendingSnapshot } from '@/hooks/use-pending-snapshot';
import { useTranslations } from '@/i18n/use-translations';
import { isBillingEnabled } from '@/lib/config';
import { useAccountState } from '@kortix/ui/internal/billing/index';
import { useProjectCanRun } from '@kortix/ui/internal/hooks/projects/use-project-can-run';
import {
  billingDialogArgs,
  billingStateAllowsRun,
  resolveBillingState,
} from '@kortix/ui/internal/lib/billing/billing-gate-state';
import { useUpgradeDialogStore } from '@kortix/ui/internal/stores/upgrade-dialog-store';
import { getProjectDetail } from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import { useQuery } from '@tanstack/react-query';

/**
 * The billing gate in front of every composer that starts a session (project
 * home, a channel, a DM): pass the result as the composer's `beforeSend`. It
 * throws to refuse a send the account cannot run, and the composer keeps the
 * draft.
 */
export function useProjectSendGate(projectId: string) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const { data: projectDetail } = useQuery({
    queryKey: qk.project.detail(projectId),
    queryFn: () => getProjectDetail(projectId),
    enabled: !!projectId,
    ...contract('config'),
  });
  const projectAccountId = projectDetail?.project?.account_id ?? undefined;
  const { isLoading: billingLoading } = useProjectCanRun(projectId);
  const { data: accountState } = useAccountState({ accountId: projectAccountId });
  const openUpgradeDialog = useUpgradeDialogStore((s) => s.openUpgradeDialog);

  // The account answer the send path waits on, readable after an await.
  const billing = usePendingSnapshot(isBillingEnabled() ? billingLoading : false, {
    accountState,
    projectAccountId,
  });

  return useCallback(async () => {
    // WAIT for the account's answer; never refuse over its absence. This
    // used to `throw new Error('Account access is still loading')`, which
    // the composer swallows into a draft restore — so an Enter pressed
    // before `/projects/:id/detail` + `/billing/account-state` landed
    // dropped the prompt silently and nothing retried. Project home paints
    // a focusable composer ~1.1s after navigation; on the staging release
    // gate those two calls still had 4.5s and 5.9s to run at that moment
    // (run 35242868705). The answer is one round trip away and the user has
    // already committed, so hold the send instead of losing it.
    // Bounded: a wedged query must refuse (as it always did) rather than
    // leave the composer waiting with nothing on screen.
    if (isBillingEnabled() && !(await billing.settled())) {
      throw new Error('Account access is still loading');
    }

    // Read through the snapshot, not this closure: after the await we are
    // running in a render that predates the answer, where `accountState` is
    // still undefined — see `usePendingSnapshot`.
    const { accountState: currentAccountState, projectAccountId: currentProjectAccountId } =
      billing.current();

    // Gate accounts that cannot run before navigating so we never strand the
    // user on a shell that cannot provision. Free accounts with the monthly
    // sandbox grant are allowed through because their state is `active`.
    const billingState = isBillingEnabled() ? resolveBillingState(currentAccountState) : null;
    if (isBillingEnabled() && !billingStateAllowsRun(billingState)) {
      openUpgradeDialog(
        billingDialogArgs(billingState, currentAccountState, currentProjectAccountId, tI18nComplete),
      );
      throw new Error('Account cannot start a session');
    }
  }, [billing, openUpgradeDialog, tI18nComplete]);
}
