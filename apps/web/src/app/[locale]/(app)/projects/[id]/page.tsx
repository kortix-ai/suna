'use client';

import { useTranslations } from '@/i18n/use-translations';

import { ProjectHome } from '@kortix/ui/workspace';
import { uiRoutes } from '@kortix/ui';
import { useAccountState } from '@kortix/ui/internal/billing/index';
import {
  billingDialogArgs,
  resolveBillingState,
} from '@kortix/ui/internal/lib/billing/billing-gate-state';
import { useProjectSendGate } from '@/hooks/projects/use-project-send-gate';
import { isBillingEnabled } from '@/lib/config';
import { useComposerPrefillStore } from '@kortix/ui/internal/stores/composer-prefill-store';
import { useUpgradeDialogStore } from '@kortix/ui/internal/stores/upgrade-dialog-store';
import { getProjectDetail } from '@kortix/sdk';
import { contract, qk, useFeatureFlag, useProjectSpaces } from '@kortix/sdk/react';
import { useQuery } from '@tanstack/react-query';
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef } from 'react';

import { resolveHomeLanding } from './home-landing';
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
  const { data: accountState } = useAccountState({ accountId: projectAccountId });
  const openUpgradeDialog = useUpgradeDialogStore((s) => s.openUpgradeDialog);
  // The send itself is the package's (`useProjectHomeSend` inside
  // ProjectHome). This gate runs first and refuses a send the account cannot run.
  const beforeSend = useProjectSendGate(projectId);

  // Channels on: home is the default channel (`resolveHomeLanding`).
  const channels = useFeatureFlag(projectId, 'project_channels');
  const spaces = useProjectSpaces(projectId, { enabled: channels.enabled });
  const landing = resolveHomeLanding({
    flagLoading: channels.isLoading,
    channelsOn: channels.enabled,
    spacesLoaded: !!spaces.data,
    spacesFailed: spaces.isError,
    defaultSlug: spaces.data?.find((space) => space.kind === 'channel' && space.is_default)?.slug,
  });
  const channelHref = landing.kind === 'channel' ? uiRoutes().channel(projectId, landing.slug) : null;

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
  // and the channel composer (space-view.tsx) consume it — then leave the URL
  // without `q` so a refresh doesn't re-seed the same prompt. `seededRef`
  // guards against re-seeding on every render once the navigation lands.
  // ONE effect owns both navigations from this page (the channel redirect and
  // the strip): two `router.replace` calls raced, and the strip could win.
  const seededRef = useRef(false);
  useEffect(() => {
    if (!projectId || landing.kind === 'wait') return;
    const prompt = seededRef.current ? null : promptFromSearchParams(searchParams);
    if (prompt) {
      seededRef.current = true;
      useComposerPrefillStore.getState().setPrefill(projectId, prompt);
    }
    if (channelHref) {
      router.replace(channelHref);
      return;
    }
    if (!prompt) return;

    const nextParams = new URLSearchParams(searchParams);
    nextParams.delete('q');
    const query = nextParams.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }, [searchParams, pathname, projectId, router, landing.kind, channelHref]);

  // Until the flag and the redirect resolve, draw nothing: home would mount,
  // flash and consume the `?q=` prefill before the redirect. Accepted cost:
  // one blank frame for a flag-off project on a cold detail load.
  if (landing.kind !== 'home') return null;
  return <ProjectHome projectId={projectId} beforeSend={beforeSend} />;
}
