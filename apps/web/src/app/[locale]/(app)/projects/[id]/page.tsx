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

  // Channels on: home is the default channel. It can be renamed, so it is
  // found by `is_default`, never by the slug `general`. A `?q=` prompt seeded
  // below rides along in the prefill store and lands in that channel's composer.
  const channels = useFeatureFlag(projectId, 'project_channels');
  const spaces = useProjectSpaces(projectId, { enabled: channels.enabled });
  const defaultSlug = spaces.data?.find((space) => space.kind === 'channel' && space.is_default)?.slug;
  useEffect(() => {
    if (defaultSlug) router.replace(uiRoutes().channel(projectId, defaultSlug));
  }, [defaultSlug, projectId, router]);

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

  // Until the redirect lands, draw nothing: home would flash under it. A
  // failed channel list, or one with no default channel, keeps today's home.
  if (channels.enabled && !spaces.isError && (!spaces.data || defaultSlug)) return null;
  return <ProjectHome projectId={projectId} beforeSend={beforeSend} />;
}
