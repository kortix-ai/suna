'use client';

import { errorToast } from '@/components/ui/toast';
import type { AttachedFile } from '@/features/session/session-chat-input';
import { promptFileParts } from '@/features/session/uploaded-file-refs';
import { useTranslations } from '@/i18n/use-translations';

import { buildNewSessionCreateInput } from '@/features/workspace/project-layout/new-session-create';
import {
  ProjectHome,
  type ProjectHomeSendOptions,
} from '@/features/workspace/project-layout/project-home';
import { useAccountState } from '@/hooks/billing';
import { useNewProjectSession } from '@/hooks/projects/use-new-project-session';
import { useProjectCanRun } from '@/hooks/projects/use-project-can-run';
import { usePendingSnapshot } from '@/hooks/use-pending-snapshot';
import {
  billingDialogArgs,
  billingStateAllowsRun,
  resolveBillingState,
} from '@/lib/billing/billing-gate-state';
import { isBillingEnabled } from '@/lib/config';
import { useComposerPrefillStore } from '@/stores/composer-prefill-store';
import { useFirstPromptPreviewStore } from '@/stores/session-composer-handoff-store';
import { useUpgradeDialogStore } from '@/stores/upgrade-dialog-store';
import {
  postWhenUploaded,
  sentFailureMessage,
  type AttachmentSubmission,
} from '@/features/session/composer/attachment-submission';
import { getProjectDetail } from '@kortix/sdk';
import { contract, qk, startSessionWithPrompt, writeStartStash } from '@kortix/sdk/react';
import { useQuery } from '@tanstack/react-query';
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

import { promptFromSearchParams } from './prompt-from-search-params';

const FREE_ONBOARDING_UPGRADE_MODAL_KEY = 'kortix:free-onboarding-upgrade-modal-shown';

export default function ProjectIndexPage() {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const tComposerAttachments = useTranslations('hardcodedUi.composerAttachments');
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

  const newSession = useNewProjectSession(projectId);
  // Composer sending state: spans Enter → create confirmed → navigation. Reset
  // only on create failure (success navigates this page away).
  const [sending, setSending] = useState(false);

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

  const handleSend = useCallback(
    async (
      text: string,
      files: AttachedFile[] | undefined,
      options?: ProjectHomeSendOptions,
      attachments?: AttachmentSubmission,
    ) => {
      if (!text.trim() && !files?.length) return;

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
          billingDialogArgs(
            billingState,
            currentAccountState,
            currentProjectAccountId,
            tI18nComplete,
          ),
        );
        throw new Error('Account cannot start a session');
      }

      // Identical create-first path to every other new-session entry point: the
      // composer shows a sending spinner for the create RTT (~one round trip),
      // then navigates into the instant shell, which auto-sends `text` once the
      // box is ready. No server-side initial_prompt — the shell shows the
      // message + inline boot status, matching the global dashboard composer.
      // Bind the chosen agent at session birth so `project_sessions.agent_name`
      // is honest from turn one: the grant re-mint and connector authz resolve
      // against that name, so an unbound session would mint the wrong agent's
      // tokens for the first prompt (see buildNewSessionCreateInput). The proxy
      // no longer refuses a prompt whose agent differs — switching is allowed.
      setSending(true);
      // Send time, not POST time. A held POST lands after the uploads, and the
      // server orders rows by this stamp: a message sent on the session page
      // meanwhile must still follow this one.
      const sentAtMs = Date.now();
      // Uploads still running at Send never hold the paint. The session is
      // created (or the warm one taken) and opened now, and the first-prompt
      // preview draws the message. Only the prompt POST waits for the uploads:
      // the create cannot carry a prompt whose upload handles do not exist yet.
      // Uploads already finished keep the create carrying the prompt.
      const heldAttachments = attachments && !attachments.readyAtSend ? attachments : undefined;
      let parts: ReturnType<typeof promptFileParts> = [];
      if (!heldAttachments) {
        try {
          const attachmentParts = attachments ? await attachments.whenReady() : [];
          parts = promptFileParts(files, attachmentParts);
        } catch (error) {
          errorToast(
            error instanceof Error ? error.message : tI18nComplete.raw('texta9c0123d9962'),
          );
          setSending(false);
          throw error;
        }
      }
      // This page unmounts with the navigation; the held POST does not. A
      // failure stays on the session page as the first prompt's failed status.
      // Keyed by the created session: a send made on the session page meanwhile
      // queues behind this POST. It starts at most once per Send.
      let heldPostStarted = false;
      const startHeldPost = (held: AttachmentSubmission, sessionId: string) => {
        if (heldPostStarted) return;
        heldPostStarted = true;
        void postWhenUploaded(
          sessionId,
          held,
          async (attachmentParts) =>
            startSessionWithPrompt(projectId, sessionId, {
              parts: [{ type: 'text' as const, text }, ...promptFileParts(files, attachmentParts)],
              overrides: {
                ...(options?.agent ? { agent: options.agent } : {}),
                ...(options?.model ? { model: options.model } : {}),
                ...(options?.variant ? { variant: options.variant } : {}),
              },
              clientSentAtMs: sentAtMs,
            }),
          (uploadStatus) =>
            useFirstPromptPreviewStore
              .getState()
              .setFirstPromptPreview(sessionId, text, files ?? [], uploadStatus),
          (error) => sentFailureMessage(error, tComposerAttachments),
        );
      };
      // A refused create can still open the session: the connector gate's Retry
      // creates it with these same options. By then the Promise below has
      // rejected, so nothing after the `await` runs, and the composer has taken
      // the uploads back, so its unmount would delete them.
      let refused = false;
      const sessionId = await new Promise<string>((resolve, reject) => {
        newSession({
          create: {
            ...buildNewSessionCreateInput(options),
            ...(heldAttachments
              ? {}
              : {
                  pending_prompt: {
                    text,
                    agent: options?.agent ?? null,
                    model: options?.model ?? null,
                    variant: options?.variant ?? null,
                    attachment_names:
                      files?.map((file) =>
                        file.kind === 'local' ? file.file.name : file.filename,
                      ) ?? [],
                    ...(parts.length > 0
                      ? { parts: [{ type: 'text' as const, text }, ...parts] }
                      : {}),
                  },
                }),
          },
          scope: options?.scope,
          // Create failed (already surfaced by the hook). Reject so the
          // composer restores its submitted draft and keeps every handle.
          onError: () => {
            refused = true;
            setSending(false);
            reject(new Error('Session creation failed'));
          },
          onNavigate: (sessionId) => {
            // `sessionId` here is the route/Kortix session id, not the OpenCode
            // pin the session page resolves later (`useCanonicalRuntimeSession`
            // /`ensureOpencodeSessionPin` mint a separate id). Stash under the
            // route id via the SDK's canonical `writeStartStash` — the session
            // page's `migrateStash` hands this off onto the resolved pin once it
            // exists, and `readStartStash` (instant shell, `useSession`) reads it
            // uniformly either side of that migration.
            // PICKS only: the prompt (and its attachments) are already a
            // durable inbox row via create.pending_prompt above — a prompt in
            // the stash here would be a second delivery channel for the same
            // message.
            writeStartStash(sessionId, {
              prompt: '',
              agent: options?.agent ?? null,
              model: options?.model ?? null,
              variant: options?.variant ?? null,
            });
            // RENDER-only copy for the boot shell, so the bubble is on screen
            // from the session page's first frame — see `useFirstPromptPreviewStore`.
            useFirstPromptPreviewStore
              .getState()
              .setFirstPromptPreview(sessionId, text, files ?? []);
            // A connector-gate Retry of a held send: hand the uploads off again
            // and POST from here. A ready send's create carried the prompt.
            if (refused && heldAttachments) {
              heldAttachments.resubmit();
              startHeldPost(heldAttachments, sessionId);
            }
            resolve(sessionId);
          },
        });
      });
      if (!heldAttachments) {
        attachments?.release();
        return;
      }
      startHeldPost(heldAttachments, sessionId);
    },
    [
      billing,
      newSession,
      openUpgradeDialog,
      projectId,
      tI18nComplete,
      tComposerAttachments,
    ],
  );

  return <ProjectHome projectId={projectId} onSend={handleSend} busy={sending} />;
}
