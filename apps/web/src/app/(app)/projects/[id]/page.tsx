'use client';

import { ProjectHome } from '@/features/workspace/project-layout/project-home';
import { useProjectHomeSend } from '@/features/workspace/project-layout/use-project-home-send';
import { useAccountState } from '@/hooks/billing';
import { billingDialogArgs, resolveBillingState } from '@/lib/billing/billing-gate-state';
import { isBillingEnabled } from '@/lib/config';
import { useComposerPrefillStore } from '@/stores/composer-prefill-store';
import { useUpgradeDialogStore } from '@/stores/upgrade-dialog-store';
import { getProjectDetail } from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import { useQuery } from '@tanstack/react-query';
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef } from 'react';

import { promptFromSearchParams } from './prompt-from-search-params';

const FREE_ONBOARDING_UPGRADE_MODAL_KEY = 'kortix:free-onboarding-upgrade-modal-shown';

export default function ProjectIndexPage() {
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

  // What a send does — shared with the subproject page's composer, which is
  // the same composer wired to the same create path with one extra field.
  const { handleSend, sending } = useProjectHomeSend(projectId, {
    accountId: projectAccountId,
  });

  // One-time "you're on Free" onboarding pitch. Keyed off the SAME resolved
  // billing state every other surface uses — the old `tier_key === 'free'`
  // guess pitched the Free plan to per-seat Team accounts, whose tier_key stays
  // 'free' (the PR #5141 lesson).
  useEffect(() => {
    if (!isBillingEnabled() || !accountState || !projectAccountId) return;
    if (resolveBillingState(accountState) !== 'no_subscription') return;

    const storageKey = `${FREE_ONBOARDING_UPGRADE_MODAL_KEY}:${projectAccountId}`;
    if (window.localStorage.getItem(storageKey) === '1') return;

    window.localStorage.setItem(storageKey, '1');
    openUpgradeDialog(billingDialogArgs('no_subscription', accountState, projectAccountId));
  }, [accountState, projectAccountId, openUpgradeDialog]);

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

  return <ProjectHome projectId={projectId} onSend={handleSend} busy={sending} />;
}
