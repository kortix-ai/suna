'use client';

import { useQuery } from '@tanstack/react-query';
import { hubTarget } from '@/stores/account-panel-store';
import { useTranslations } from '@/i18n/use-translations';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { ComposerChatInput, type ComposerOptions } from '@/features/session/composer-chat-input';
import type { DraftScope } from '@/features/session/composer/draft/composer-draft';
import { OptimisticTurn } from '@/features/session/optimistic-turn';
import type { AttachedFile } from '@/features/session/session-chat-input';
import {
  buildOptimisticPromptTextWithUploads,
  sentAttachmentsOf,
} from '@/features/session/uploaded-file-refs';
import { SidebarToggle } from '@/features/workspace/project-layout/sidebar-toggle';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';
import { useComposerPrefillStore } from '@/stores/composer-prefill-store';
import {
  getProjectDetail,
  listProjectAccessRequests,
  listProjectSandboxes,
  type SandboxTemplate,
} from '@kortix/sdk';
import type { AttachmentSubmission } from '@/features/session/composer/attachment-submission';
import { contract, qk, type Command } from '@kortix/sdk/react';
import { META_SANDBOX_SLUG, isMetaAgentName } from '@kortix/shared';
import { AccessRequestsBell } from './home/access-requests-bell';
import { MetaRuntimeIndicator } from './home/meta-runtime-indicator';
import { SandboxPicker } from './home/sandbox-picker';
import { ProjectHomeWallpaper, ProjectHomeWelcomeBody } from './home/welcome-body';

// This path is this view's public surface — the instant session shell and the
// IAM tests already import from here, so the moved pieces keep their address.
export { PROJECT_SETUP_TILE_ACTIONS } from './home/setup-tiles';
export { ProjectHomeWelcomeBody } from './home/welcome-body';

export interface ProjectHomeSendOptions extends ComposerOptions {
  sandbox_slug?: string;
}

/**
 * The project's home screen: the wallpaper, the floating sidebar opener, the
 * access-requests bell, and the centred column holding the composer and the
 * setup checklist.
 *
 * This component owns the composer's WIRING — which sandbox, which agent, what
 * a send carries, what a prefill does. Everything it renders is a component of
 * its own under `./home/`, and the column's layout lives in
 * `ProjectHomeWelcomeBody` because the instant session shell renders that same
 * column with none of this wiring.
 */
export function ProjectHome({
  projectId,
  onSend,
  busy,
}: {
  projectId: string;
  onSend: (
    text: string,
    files: AttachedFile[] | undefined,
    options?: ProjectHomeSendOptions,
    attachments?: AttachmentSubmission,
  ) => void | Promise<void>;
  busy: boolean;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');

  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [prefill, setPrefill] = useState<{ text: string; id: number } | null>(null);
  /**
   * The message this screen has just sent, painted here until the navigation
   * lands — the "fake send" every other composer in the app already does.
   *
   * Send on this screen used to leave the sentence sitting in a locked box
   * behind a spinner for the whole create round trip, because the composer was
   * told not to clear (`clearOnSend={false}`, for the attachment previews the
   * instant shell needs). Measured on localhost: 1165ms from click to the
   * session route, `POST .../sessions` alone 908ms, all of it with nothing on
   * screen to say the message had gone anywhere.
   *
   * Cleared only by a REFUSED send. A successful one navigates this component
   * away, and the instant shell re-paints this same `OptimisticTurn` on the
   * other side (`useFirstPromptPreviewStore`), so the bubble never blinks out.
   */
  const [sentPreview, setSentPreview] = useState<{
    text: string;
    files: AttachedFile[] | undefined;
  } | null>(null);

  // The sandbox TEMPLATE catalog, not live sandbox health (that is
  // `useSandboxHealth`, its own key and its own polling). Changed only by this
  // app's own mutations, which invalidate this key — see `FRESHNESS.sandboxes`.
  const sandboxesQuery = useQuery({
    queryKey: qk.project.sandboxes(projectId),
    queryFn: () => listProjectSandboxes(projectId),
    ...contract('config'),
    refetchOnWindowFocus: false,
  });
  const sandboxItems: SandboxTemplate[] = sandboxesQuery.data?.items ?? [];
  const defaultSlug = sandboxesQuery.data?.default_slug ?? 'default';
  const activeSlug = selectedSlug ?? defaultSlug;
  const metaSelected = isMetaAgentName(selectedAgent);

  useEffect(() => {
    if (metaSelected) setSelectedSlug(null);
  }, [metaSelected]);

  const showSandboxPicker = sandboxItems.length >= 1;
  // `GET /projects/:id/access-requests` asserts project.members.manage
  // (`apps/api/src/projects/routes/r6.ts`), so firing it for a plain member is
  // a guaranteed 403 for a bell they could never act on anyway. Probe the leaf
  // first and keep the query disabled until it says yes — `showErrors: false`
  // only silenced the toast, the request still went out and still failed.
  const canManageMembers =
    useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE).allowed === true;
  const accessRequests = useQuery({
    queryKey: qk.project.accessRequests(projectId),
    queryFn: () => listProjectAccessRequests(projectId, { showErrors: false }),
    retry: false,
    enabled: canManageMembers,
    ...contract('inventory'),
    refetchOnWindowFocus: false,
  });
  const pendingAccessCount = accessRequests.data?.requests.length ?? 0;

  // Same query key page.tsx (`ProjectIndexPage`) already fetches for this
  // project — this dedupes against that cache entry rather than firing a
  // second request. Needed here only to resolve `account_id` for the pending
  // access requests bell below, which now routes into the account hub's
  // Access tab (`/accounts/<id>?tab=access-projects`) instead of the deleted
  // project Members capability tab.
  const projectDetailQuery = useQuery({
    queryKey: qk.project.detail(projectId),
    queryFn: () => getProjectDetail(projectId),
    enabled: !!projectId,
    ...contract('config'),
  });
  const accountId = projectDetailQuery.data?.project?.account_id;
  // Resolved during render so the bell is an anchor and Next holds its payload
  // in the segment cache. `account_id` arrives on a different query than the
  // count, so the bell can paint before the destination exists.
  const accessRequestsTo = accountId
    ? hubTarget(accountId, { tab: 'access-projects', project: projectId })
    : null;

  const handleSend = useCallback(
    async (
      text: string,
      files: AttachedFile[] | undefined,
      options: ComposerOptions,
      attachments?: AttachmentSubmission,
    ) => {
      // BEFORE the host runs, in the same tick as the composer's own clear, so
      // the message is on screen from the frame the box empties.
      setSentPreview({ text, files });
      try {
        await onSend(
          text,
          files,
          {
            ...options,
            ...(metaSelected
              ? { sandbox_slug: META_SANDBOX_SLUG }
              : selectedSlug
                ? { sandbox_slug: selectedSlug }
                : {}),
          },
          attachments,
        );
      } catch (error) {
        // Refused: no session was created and nothing navigated. Take the
        // bubble back and rethrow, so the composer restores the draft and the
        // uploads that produced it (`planFailedSendRecovery`) — which it can,
        // because it never left its slot. See the layout note below.
        setSentPreview(null);
        throw error;
      }
    },
    [metaSelected, selectedSlug, onSend],
  );

  const pendingPrefill = useComposerPrefillStore((s) => s.prefillByProject[projectId]);
  const consumePrefill = useComposerPrefillStore((s) => s.consume);

  // Send rejects on failure so the composer keeps its attachment handles.
  // These callers have no composer draft; the session hook shows the error.
  const sendOutsideComposer = useCallback(
    (text: string, options: ComposerOptions) => {
      void Promise.resolve(handleSend(text, undefined, options)).catch(() => undefined);
    },
    [handleSend],
  );

  useEffect(() => {
    if (!pendingPrefill) return;
    consumePrefill(projectId);
    // The onboarding hand-off (`project-onboarding-wizard.tsx`) sets
    // `autoSend: true` so the finish step's "Open project" click actually
    // starts the first turn instead of just filling the box — see
    // `composer-prefill-store.ts`. Every other caller (the `?q=` deep link,
    // the command palette) omits the flag and keeps the old prefill-only
    // behavior below.
    if (pendingPrefill.autoSend) {
      sendOutsideComposer(pendingPrefill.text, {});
      return;
    }
    setPrefill({ text: pendingPrefill.text, id: Date.now() });
  }, [pendingPrefill, projectId, consumePrefill, sendOutsideComposer]);

  const handleCommand = useCallback(
    (cmd: Command, args: string | undefined, options: ComposerOptions) => {
      sendOutsideComposer(`/${cmd.name}${args ? ` ${args}` : ''}`, options);
    },
    [sendOutsideComposer],
  );

  const applySuggestion = (s: string) => {
    setPrefill({ text: s, id: Date.now() });
  };

  // The home composer has no session yet, so its unsent draft is keyed by the
  // project. Memoized because it crosses into a `React.memo`-wrapped composer.
  const draftScope = useMemo<DraftScope>(() => ({ kind: 'project', projectId }), [projectId]);

  // The template chooser lives inside the overrides panel, not on the bar —
  // the bar keeps only agent + model. Meta takes a fixed sandbox, so it gets
  // the indicator instead of a picker whose choice would be ignored.
  const sandboxSlot =
    !metaSelected && showSandboxPicker
      ? {
          summary: selectedSlug
            ? (sandboxItems.find((t) => t.slug === selectedSlug)?.name ?? selectedSlug)
            : 'Agent default',
          overridden: selectedSlug !== null,
          control: (
            <SandboxPicker
              items={sandboxItems}
              activeSlug={activeSlug}
              selectedSlug={selectedSlug}
              onSelect={setSelectedSlug}
            />
          ),
          onReset: () => setSelectedSlug(null),
          resetLabel: 'Reset to agent default',
        }
      : undefined;


  return (
    <div className="bg-background relative flex min-h-0 flex-1 flex-col overflow-hidden lg:px-4.5">
      {/* Gone the moment a message is sent, exactly as the instant session
          shell drops its own copy at the same instant: a thread sits on a solid
          background, and leaving the dots up here would make the navigation a
          visible dotted → plain swap under a bubble that otherwise does not
          move. */}
      {!sentPreview && <ProjectHomeWallpaper />}
      <SidebarToggle placement="floating" />
      <AccessRequestsBell count={pendingAccessCount} to={accessRequestsTo} />

      {/* ONE layout, in both states, and that is the constraint — not a
          preference. The composer owns its upload registry
          (`usePromptAttachments`, composer.tsx), its editor, its draft and its
          submit latch, so moving it to a different parent unmounts it and
          takes all of that with it. A version of this screen that docked the
          composer under the thread did exactly that, and the e2e journey
          caught what it cost: after a refused send the tray showed its three
          tiles and the text was back, but the handles behind them were gone,
          so the next Send silently did nothing
          (`captureAttachmentSubmission` no longer recognised the ids).

          So the turn takes the HEADING's slot and everything else holds still.
          The bubble travels once, at the navigation, when the instant shell
          re-paints it at the top of a real thread. */}
      <ProjectHomeWelcomeBody
        projectId={projectId}
        onPickSuggestion={applySuggestion}
        sentTurn={
          sentPreview ? (
            // The instant shell's own component, given the same inputs it gives
            // itself, so the bubble is identical across the navigation — see
            // `OptimisticTurn`'s doc comment on why there is exactly one of
            // these in the codebase. `deferPreview`: there is no sandbox yet,
            // so a file mention has no path to resolve and renders as a static
            // chip.
            <OptimisticTurn
              text={buildOptimisticPromptTextWithUploads(sentPreview.text, sentPreview.files)}
              attachments={sentPreview.files ? sentAttachmentsOf(sentPreview.files) : undefined}
              deferPreview
            />
          ) : undefined
        }
        composer={
          <ComposerChatInput
            onSend={handleSend}
            onCommand={handleCommand}
            projectId={projectId}
            draftScope={draftScope}
            // `busy` here means "create in flight" — spinner in the send slot,
            // input locked. NOT isBusy (that renders agent-running stop-button
            // semantics, which leave the composer with no button at all here).
            isSending={busy}
            disabled={busy}
            // Clear the box, revoke nothing (`composer-reset.ts`). The text
            // has to LEAVE the composer at the keypress — it used to sit there
            // locked under the spinner for the whole create round trip, which
            // reads as a send that did not happen — while the local object URLs
            // behind any attachments stay alive, because the instant shell
            // draws its previews from those same URLs after the navigation.
            // The sentence itself is not lost by clearing: it is already in
            // this send's closure, in the durable `create.pending_prompt` row,
            // and in `sentPreview` above; a refused send puts it back in the
            // editor (`planFailedSendRecovery`).
            clearOnSend="text-only"
            autoFocus
            // A hero composer floating mid-page has no column for a second
            // rail to align to, so the attach/agent/context controls ride on
            // the toolbar itself, ahead of the model selector. The session
            // page keeps the default row beneath the card.
            underbarPlacement="inline"
            // Hero composer mid-page: the `/` menu opens BELOW the card, into
            // the empty lower half, instead of shoving the heading up.
            slashMenuPlacement="below"
            placeholder={tI18nHardcoded.raw(
              'autoFeaturesCoWorkerProjectLayoutProjectHomeJsxAttrPlaceholder115e6c2d',
            )}
            prefill={prefill}
            onAgentSelectionChange={setSelectedAgent}
            toolbarSlot={metaSelected ? <MetaRuntimeIndicator /> : null}
            sandboxSlot={sandboxSlot}
          />
        }
      />
    </div>
  );
}
