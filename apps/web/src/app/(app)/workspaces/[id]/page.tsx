'use client';

import type { AttachedFile } from '@/features/session/session-chat-input';

import { buildNewSessionCreateInput } from '@/features/workspace/workspace-layout/new-session-create';
import {
  WorkspaceHome,
  type WorkspaceHomeSendOptions,
} from '@/features/workspace/workspace-layout/workspace-home';
import { useAccountState } from '@/hooks/billing';
import { useNewWorkspaceSession } from '@/hooks/workspaces/use-new-workspace-session';
import { useWorkspaceCanRun } from '@/hooks/workspaces/use-workspace-can-run';
import {
  billingDialogArgs,
  billingStateAllowsRun,
  resolveBillingState,
} from '@/lib/billing/billing-gate-state';
import { isBillingEnabled } from '@/lib/config';
import { useComposerPrefillStore } from '@/stores/composer-prefill-store';
import { usePendingFilesStore } from '@/stores/session-composer-handoff-store';
import { useUpgradeDialogStore } from '@/stores/upgrade-dialog-store';
import { getWorkspaceDetail } from '@kortix/sdk';
import { contract, qk, writeStartStash } from '@kortix/sdk/react';
import { useQuery } from '@tanstack/react-query';
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

import { promptFromSearchParams } from './prompt-from-search-params';

const FREE_ONBOARDING_UPGRADE_MODAL_KEY = 'kortix:free-onboarding-upgrade-modal-shown';

export default function WorkspaceIndexPage() {
  const { id: workspaceId } = useParams<{ id: string }>();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const { data: workspaceDetail } = useQuery({
    queryKey: qk.workspace.detail(workspaceId),
    queryFn: () => getWorkspaceDetail(workspaceId),
    enabled: !!workspaceId,
    ...contract('config'),
  });
  const workspaceAccountId = workspaceDetail?.workspace?.account_id ?? undefined;
  const { canRun, isLoading: billingLoading } = useWorkspaceCanRun(workspaceId);
  const { data: accountState } = useAccountState({ accountId: workspaceAccountId });
  const openUpgradeDialog = useUpgradeDialogStore((s) => s.openUpgradeDialog);

  const newSession = useNewWorkspaceSession(workspaceId);
  // Composer sending state: spans Enter → create confirmed → navigation. Reset
  // only on create failure (success navigates this page away).
  const [sending, setSending] = useState(false);

  // One-time "you're on Free" onboarding pitch. Keyed off the SAME resolved
  // billing state every other surface uses — the old `tier_key === 'free'`
  // guess pitched the Free plan to per-seat Team accounts, whose tier_key stays
  // 'free' (the PR #5141 lesson).
  useEffect(() => {
    if (!isBillingEnabled() || !accountState || !workspaceAccountId) return;
    if (resolveBillingState(accountState) !== 'no_subscription') return;

    const storageKey = `${FREE_ONBOARDING_UPGRADE_MODAL_KEY}:${workspaceAccountId}`;
    if (window.localStorage.getItem(storageKey) === '1') return;

    window.localStorage.setItem(storageKey, '1');
    openUpgradeDialog(billingDialogArgs('no_subscription', accountState, workspaceAccountId));
  }, [accountState, workspaceAccountId, openUpgradeDialog]);

  // `/workspaces/start?q=<prompt>` forwards its query string onto this route
  // unchanged (see `withCurrentQuery` in `../start/page.tsx`), landing here as
  // `/projects/<id>?q=<prompt>`. Seed the one-shot prefill store — WorkspaceHome
  // already consumes it (workspace-home.tsx) — then strip `q` from the URL so a
  // refresh doesn't re-seed the same prompt. `seededRef` guards against
  // re-seeding on every render once the strip lands.
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current) return;
    const prompt = promptFromSearchParams(searchParams);
    if (!prompt || !workspaceId) return;

    seededRef.current = true;
    useComposerPrefillStore.getState().setPrefill(workspaceId, prompt);

    const nextParams = new URLSearchParams(searchParams);
    nextParams.delete('q');
    const query = nextParams.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }, [searchParams, pathname, workspaceId, router]);

  const handleSend = useCallback(
    (text: string, files: AttachedFile[] | undefined, options?: WorkspaceHomeSendOptions) => {
      if (!text.trim() && !files?.length) return;

      if (isBillingEnabled() && billingLoading) return;

      // Gate accounts that cannot run before navigating so we never strand the
      // user on a shell that cannot provision. Free accounts with the monthly
      // sandbox grant are allowed through because their state is `active`.
      const billingState = isBillingEnabled() ? resolveBillingState(accountState) : null;
      if (isBillingEnabled() && !billingLoading && !billingStateAllowsRun(billingState)) {
        openUpgradeDialog(billingDialogArgs(billingState, accountState, workspaceAccountId));
        return;
      }

      // Identical create-first path to every other new-session entry point: the
      // composer shows a sending spinner for the create RTT (~one round trip),
      // then navigates into the instant shell, which auto-sends `text` once the
      // box is ready. No server-side initial_prompt — the shell shows the
      // message + inline boot status, matching the global dashboard composer.
      // Bind the chosen agent at session birth so it matches the `agent` the
      // composer sends on the first prompt — sessions are agent-immutable and the
      // API proxy 409s any prompt whose agent differs from the bound one, which
      // defaults to "default" when unset (see buildNewSessionCreateInput).
      setSending(true);
      newSession({
        create: {
          ...buildNewSessionCreateInput(options),
          pending_prompt: {
            text,
            agent: options?.agent ?? null,
            model: options?.model ?? null,
            variant: options?.variant ?? null,
            attachment_names:
              files?.map((file) => (file.kind === 'local' ? file.file.name : file.filename)) ?? [],
          },
        },
        scope: options?.scope,
        // Create failed (already surfaced by the hook) — we never left this
        // page, so just unlock the composer with the text still in it.
        onError: () => setSending(false),
        onNavigate: (sessionId) => {
          // `sessionId` here is the route/Kortix session id, not the OpenCode
          // pin the session page resolves later (`useCanonicalRuntimeSession`
          // /`ensureOpencodeSessionPin` mint a separate id). Stash under the
          // route id via the SDK's canonical `writeStartStash` — the session
          // page's `migrateStash` hands this off onto the resolved pin once it
          // exists, and `readStartStash` (instant shell, `useSession`) reads it
          // uniformly either side of that migration.
          writeStartStash(sessionId, {
            prompt: text,
            agent: options?.agent ?? null,
            model: options?.model ?? null,
            variant: options?.variant ?? null,
          });
          if (files?.length) {
            usePendingFilesStore.getState().setPendingFiles(files);
          }
        },
      });
    },
    [billingLoading, accountState, workspaceAccountId, openUpgradeDialog, newSession],
  );

  return <WorkspaceHome workspaceId={workspaceId} onSend={handleSend} busy={sending} />;
}
