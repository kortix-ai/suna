'use client';

/**
 * What a send on the `ProjectHome` composer does.
 *
 * Two surfaces mount that composer — the project index (`/projects/[id]`) and
 * a subproject page (`/projects/[id]/subprojects/[slug]`) — and they must do
 * the SAME thing on Enter: gate on billing, turn attachments into data: URLs,
 * create the session with a durable `pending_prompt`, stash the picks, seed
 * the first-prompt preview, navigate. The only difference between them is two
 * values, and both are arguments here:
 *
 *  - `subproject` — filed onto the create body, and the reason the warm-session
 *    pool is skipped (`use-new-project-session.ts`).
 *  - `defaultAgent` — the subproject's own `agent`, used when the composer
 *    picked none. It is resolved ONCE and then used for the create bind, the
 *    pending prompt and the start stash, so those three can never disagree.
 *
 * Extracted from `app/(app)/projects/[id]/page.tsx`, which now calls it.
 */

import { useCallback, useState } from 'react';

import { errorToast } from '@/components/ui/toast';
import type { AttachedFile } from '@/features/session/session-chat-input';
import { attachedFilesToDataUrlParts } from '@/features/session/uploaded-file-refs';
import { buildNewSessionCreateInput } from '@/features/workspace/project-layout/new-session-create';
import type { ProjectHomeSendOptions } from '@/features/workspace/project-layout/project-home';
import { useAccountState } from '@/hooks/billing';
import { useNewProjectSession } from '@/hooks/projects/use-new-project-session';
import { useProjectCanRun } from '@/hooks/projects/use-project-can-run';
import {
  billingDialogArgs,
  billingStateAllowsRun,
  resolveBillingState,
} from '@/lib/billing/billing-gate-state';
import { isBillingEnabled } from '@/lib/config';
import { useFirstPromptPreviewStore } from '@/stores/session-composer-handoff-store';
import { useUpgradeDialogStore } from '@/stores/upgrade-dialog-store';
import { writeStartStash } from '@kortix/sdk/react';

export interface ProjectHomeSendConfig {
  /** The owning account, for the billing gate's upgrade dialog. */
  accountId?: string;
  /** Start every session from this composer inside this subproject. */
  subproject?: string;
  /** Boot agent when the composer picked none — a subproject's `agent`. */
  defaultAgent?: string | null;
}

export function useProjectHomeSend(projectId: string, config: ProjectHomeSendConfig = {}) {
  const { accountId, subproject, defaultAgent } = config;
  const { isLoading: billingLoading } = useProjectCanRun(projectId);
  const { data: accountState } = useAccountState({ accountId });
  const openUpgradeDialog = useUpgradeDialogStore((s) => s.openUpgradeDialog);
  const newSession = useNewProjectSession(projectId);
  // Composer sending state: spans Enter → create confirmed → navigation. Reset
  // only on create failure (success navigates this page away).
  const [sending, setSending] = useState(false);

  const handleSend = useCallback(
    async (text: string, files: AttachedFile[] | undefined, options?: ProjectHomeSendOptions) => {
      if (!text.trim() && !files?.length) return;

      // Nothing is decided while the account's billing state is still in
      // flight — sending then would gate on a state we have not read.
      if (isBillingEnabled() && billingLoading) return;

      // Gate accounts that cannot run before navigating so we never strand the
      // user on a shell that cannot provision. Free accounts with the monthly
      // sandbox grant are allowed through because their state is `active`.
      const billingState = isBillingEnabled() ? resolveBillingState(accountState) : null;
      if (isBillingEnabled() && !billingStateAllowsRun(billingState)) {
        openUpgradeDialog(billingDialogArgs(billingState, accountState, accountId));
        return;
      }

      // The one resolved agent. The create bind, the durable pending prompt and
      // the start stash all read THIS value.
      const agent = options?.agent || defaultAgent || null;

      setSending(true);
      // Attachments ride the create itself as data: URLs — the session's
      // sandbox does not exist yet, so there is nowhere to upload into. The
      // API turns this whole pending_prompt into a durable inbox row in the
      // same transaction as the session, so the message survives a closed tab
      // from this moment on. Over the cap, the refusal names the way out.
      let parts: Awaited<ReturnType<typeof attachedFilesToDataUrlParts>>;
      try {
        parts = await attachedFilesToDataUrlParts(files);
      } catch (error) {
        errorToast(error instanceof Error ? error.message : 'Attachments are too large');
        setSending(false);
        return;
      }

      newSession({
        create: {
          ...buildNewSessionCreateInput({ ...options, agent: agent ?? undefined, subproject }),
          pending_prompt: {
            text,
            agent,
            model: options?.model ?? null,
            variant: options?.variant ?? null,
            attachment_names:
              files?.map((file) => (file.kind === 'local' ? file.file.name : file.filename)) ?? [],
            ...(parts.length > 0 ? { parts: [{ type: 'text' as const, text }, ...parts] } : {}),
          },
        },
        scope: options?.scope,
        // Create failed (already surfaced by the hook) — we never left this
        // page, so just unlock the composer with the text still in it.
        onError: () => setSending(false),
        onNavigate: (sessionId) => {
          // `sessionId` here is the route/Kortix session id, not the OpenCode
          // pin the session page resolves later. Stash under the route id via
          // the SDK's canonical `writeStartStash`. PICKS only: the prompt (and
          // its attachments) are already a durable inbox row above.
          writeStartStash(sessionId, {
            prompt: '',
            agent,
            model: options?.model ?? null,
            variant: options?.variant ?? null,
          });
          // RENDER-only copy for the boot shell, so the bubble is on screen
          // from the session page's first frame.
          useFirstPromptPreviewStore.getState().setFirstPromptPreview(sessionId, text, files ?? []);
        },
      });
    },
    [
      billingLoading,
      accountState,
      accountId,
      openUpgradeDialog,
      newSession,
      subproject,
      defaultAgent,
    ],
  );

  return { handleSend, sending };
}
