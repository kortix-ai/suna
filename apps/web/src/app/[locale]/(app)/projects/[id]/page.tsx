'use client';

import { useTranslations } from '@/i18n/use-translations';

import { ProjectHome } from '@kortix/ui/workspace';
import { useAccountState } from '@kortix/ui/internal/billing/index';
import { useProjectCanRun } from '@kortix/ui/internal/hooks/projects/use-project-can-run';
import { usePendingSnapshot } from '@/hooks/use-pending-snapshot';
import {
  billingDialogArgs,
  billingStateAllowsRun,
  resolveBillingState,
} from '@kortix/ui/internal/lib/billing/billing-gate-state';
import { isBillingEnabled } from '@/lib/config';
import { useComposerPrefillStore } from '@kortix/ui/internal/stores/composer-prefill-store';
import { useUpgradeDialogStore } from '@kortix/ui/internal/stores/upgrade-dialog-store';
import { getProjectDetail } from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import { useQuery } from '@tanstack/react-query';
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef } from 'react';

import { promptFromSearchParams } from './prompt-from-search-params';

const FREE_ONBOARDING_UPGRADE_MODAL_KEY = 'kortix:free-onboarding-upgrade-modal-shown';

export default function ProjectIndexPage() {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const { id: projectId } = useParams<{ id: string }>();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const { data: projectDetail } = useQuery({
    queryKey: qk.project.detail(projectId),
    queryFn: () => getProjectDetail(projectId),
    enabled: !!projectId,
    ...contract('config'),
  });
  const projectAccountId = projectDetail?.project?.account_id ?? undefined;
  const { canRun, isLoading: billingLoading } = useProjectCanRun(projectId);
  const { data: accountState } = useAccountState({ accountId: projectAccountId });
  const openUpgradeDialog = useUpgradeDialogStore((s) => s.openUpgradeDialog);

  // The account answer the send path waits on, readable after an await.
  const billing = usePendingSnapshot(isBillingEnabled() ? billingLoading : false, {
    accountState,
    projectAccountId,
  });

  // One-time "you're on Free" onboarding pitch. Keyed off the SAME resolved
  // billing state every other surface uses — the old `tier_key === 'free'`
  // guess pitched the Free plan to paying accounts whose stored tier_key lagged
  // (the PR #5141 lesson).
  useEffect(() => {
    if (!isBillingEnabled() || !accountState || !projectAccountId) return;
    if (resolveBillingState(accountState) !== 'no_subscription') return;

    const storageKey = `${FREE_ONBOARDING_UPGRADE_MODAL_KEY}:${projectAccountId}`;
    if (window.localStorage.getItem(storageKey) === '1') return;

    window.localStorage.setItem(storageKey, '1');
    openUpgradeDialog(
      billingDialogArgs('no_subscription', accountState, projectAccountId, tI18nComplete),
    );
  }, [accountState, projectAccountId, openUpgradeDialog, tI18nComplete]);

  // `/projects/start?q=<prompt>` forwards its query string onto this route
  // unchanged (see `withCurrentQuery` in `../start/page.tsx`), landing here as
  // `/projects/<id>?q=<prompt>`. Seed the one-shot prefill store — ProjectHome
  // already consumes it (project-home.tsx) — then strip `q` from the URL so a
  // refresh doesn't re-seed the same prompt. `seededRef` guards against
  // re-seeding on every render once the strip lands.
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current) return;
    const prompt = promptFromSearchParams(searchParams);
    if (!prompt || !projectId) return;

    seededRef.current = true;
    useComposerPrefillStore.getState().setPrefill(projectId, prompt);

    const nextParams = new URLSearchParams(searchParams);
    nextParams.delete('q');
    const query = nextParams.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }, [searchParams, pathname, projectId, router]);

  // The send itself is the package's (`useProjectHomeSend` inside
  // ProjectHome). This gate runs first and refuses a send the account cannot run.
  const beforeSend = useCallback(async () => {
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

  return <ProjectHome projectId={projectId} beforeSend={beforeSend} />;
}
