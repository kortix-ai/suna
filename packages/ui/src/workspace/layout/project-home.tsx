'use client';

import { useQuery } from '@tanstack/react-query';
import { hubTarget } from '../../internal/stores/account-panel-store';
import { useTranslations } from '../../i18n';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { ComposerChatInput, type ComposerOptions } from '../../session/composer/composer-chat-input';
import { ComposerDropZone } from '../../session/composer/composer-drop-zone';
import type { DraftScope } from '../../session/composer/draft/composer-draft';
import type { AttachedFile } from '../../session/composer/session-chat-input';
import { SidebarToggle } from '../../internal/layout/sidebar-toggle';
import { PROJECT_ACTIONS } from '../../internal/lib/project-actions';
import { useIsMobile } from '../../internal/hooks';
import { useProjectCan } from '../../internal/lib/use-project-can';
import { useComposerPrefillStore } from '../../internal/stores/composer-prefill-store';
import { isFirstChatRequested, useFirstChatPending } from '../../internal/stores/first-chat-store';
import { ProjectScope } from '../../internal/project-scope';
import { useUiComponents, useUiSearchParams } from '../../providers/ui-provider';
import {
  getProjectDetail,
  listProjectAccessRequests,
  listProjectSandboxes,
  type SandboxTemplate,
  type SessionPromptOverrides,
} from '@kortix/sdk';
import type { AttachmentSubmission } from '../../session/composer/attachment-submission';
import { contract, qk, type Command } from '@kortix/sdk/react';
import { META_SANDBOX_SLUG, isMetaAgentName } from '@kortix/shared';
import { AccessRequestsBell } from '../home/access-requests-bell';
import { notificationCenterOn } from '../../internal/hooks/use-notification-center';
import { FirstChat } from '../home/first-chat';
import { SandboxPicker } from '../home/sandbox-picker';
import { ProjectHomeWallpaper, ProjectHomeWelcomeBody } from '../home/welcome-body';
import { useProjectHomeSend } from './use-project-home-send';

// This path is this view's public surface — the instant session shell and the
// IAM tests already import from here, so the moved pieces keep their address.
export { ProjectHomeWelcomeBody } from '../home/welcome-body';

export interface ProjectHomeSendOptions extends ComposerOptions {
  sandbox_slug?: string;
}

/**
 * The project's home screen: the wallpaper, the floating sidebar opener, the
 * access-requests bell, and the centred column holding the composer and the
 * setup checklist.
 *
 * Until a new project's first message is sent, the column is the first chat
 * instead (`home/first-chat.tsx`, started by onboarding): the same composer,
 * docked at the bottom under a welcome from Kortix.
 *
 * This component owns the composer's WIRING — which sandbox, which agent, what
 * a send carries, what a prefill does. Everything it renders is a component of
 * its own under `../../../../../apps/web/src/features/workspace/project-layout/home/`, and the column's layout lives in
 * `ProjectHomeWelcomeBody` because the instant session shell renders that same
 * column with none of this wiring.
 */
export type ProjectHomeProps = {
  projectId: string;
  /**
   * Replaces the send. Default: `useProjectHomeSend` creates the session with
   * the prompt and opens it.
   */
  onSend?: (
    text: string,
    files: AttachedFile[] | undefined,
    options?: ProjectHomeSendOptions,
    attachments?: AttachmentSubmission,
  ) => void | Promise<void>;
  /** With `onSend`: a create is in flight. */
  busy?: boolean;
  /** With the default send: runs first; throw to refuse the send (the draft stays). */
  beforeSend?: () => Promise<void>;
};

/**
 * Self-contained: the composer and its pickers read the project from
 * `SessionIdsProvider`, so the home provides it for its own subtree.
 */
export function ProjectHome(props: ProjectHomeProps) {
  return (
    <ProjectScope projectId={props.projectId}>
      <ProjectHomeView {...props} />
    </ProjectScope>
  );
}

function ProjectHomeView({
  projectId,
  onSend,
  busy,
  beforeSend,
}: ProjectHomeProps) {
  const defaultSend = useProjectHomeSend(projectId, { beforeSend });
  const { HomeAnnouncement } = useUiComponents();
  const send = onSend ?? defaultSend.send;
  const creating = onSend ? !!busy : defaultSend.sending;
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const tFirstChat = useTranslations('firstChat');
  // The first chat never ends, but it opens only when asked for
  // (`firstChatHref`: the sidebar row or the onboarding exit). Plain project
  // home, which "New session" opens, stays the normal home.
  const searchParams = useUiSearchParams();
  const firstChatPending = useFirstChatPending(projectId);
  const firstChat = firstChatPending && isFirstChatRequested(searchParams);

  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [prefill, setPrefill] = useState<{
    text: string;
    id: number;
    submit?: boolean;
    files?: AttachedFile[];
    options?: SessionPromptOverrides;
  } | null>(null);

  // The sandbox TEMPLATE catalog, not live sandbox health (that is
  // `useSandboxHealth`, its own key and its own polling). Changed only by this
  // app's own mutations, which invalidate `qk.project.sandboxes` (a prefix of
  // this key) — see `FRESHNESS.sandboxes`. Same entry as the Customize prefetch
  // and the agent editor: one `GET /sandboxes` per load, not two.
  const sandboxesQuery = useQuery({
    queryKey: qk.project.sandboxTemplates(projectId),
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
  // (`apps/api/src/projects/routes/access-requests.ts`), so firing it for a plain member is
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
  // The onboarding wizard opens over this page until the project is stamped
  // (`project-shell.tsx`); the promo waits for the stamp (KRTX-2378).
  const onboarded = Boolean(
    (projectDetailQuery.data?.project?.metadata as { onboarding_completed_at?: string } | undefined)
      ?.onboarding_completed_at,
  );
  // Resolved during render so the bell is an anchor and Next holds its payload
  // in the segment cache. `account_id` arrives on a different query than the
  // count, so the bell can paint before the destination exists.
  const accessRequestsTo = accountId
    ? hubTarget(accountId, { tab: 'access-projects', project: projectId })
    : null;

  const handleSend = useCallback(
    (
      text: string,
      files: AttachedFile[] | undefined,
      options: ComposerOptions,
      attachments?: AttachmentSubmission,
    ) => {
      const sent = send(
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
      return sent;
    },
    [metaSelected, selectedSlug, send],
  );

  const isMobile = useIsMobile();
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
    setPrefill({
      text: pendingPrefill.text,
      id: Date.now(),
      submit: pendingPrefill.submit,
      files: pendingPrefill.files,
      options: pendingPrefill.options,
    });
  }, [pendingPrefill, projectId, consumePrefill]);

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

  const composer = (
    <ComposerChatInput
      onSend={handleSend}
      onCommand={handleCommand}
      projectId={projectId}
      draftScope={draftScope}
      // `busy` here means "create in flight" — spinner in the send slot,
      // input locked. NOT isBusy (that renders agent-running stop-button
      // semantics, which leave the composer with no button at all here).
      isSending={creating}
      disabled={creating}
      // The home composer navigates to the new session on send — don't
      // clear it first (that would drop the text on a gated send). The
      // message rides across via `create.pending_prompt` and reappears
      // as the instant shell's optimistic turn.
      clearOnSend={false}
      autoFocus
      // Desktop: a hero composer floating mid-page has no column for a second
      // rail to align to, so the attach/agent/context controls ride on the
      // toolbar itself, ahead of the model selector, and the `/` menu opens
      // BELOW the card, into the empty lower half, instead of shoving the
      // heading up. Mobile: the toolbar is too narrow to hold them next to the
      // model selector — the labels overlap — so it uses the session page's
      // row beneath the card. The first chat docks the composer at the bottom
      // like a session does, so it keeps a session's defaults: the row
      // beneath, the menu above.
      underbarPlacement={firstChat || isMobile ? 'below' : 'inline'}
      slashMenuPlacement={firstChat ? 'above' : 'below'}
      placeholder={
        firstChat
          ? tFirstChat('placeholder')
          : tI18nHardcoded.raw(
              'autoFeaturesCoWorkerProjectLayoutProjectHomeJsxAttrPlaceholder115e6c2d',
            )
      }
      prefill={prefill}
      onAgentSelectionChange={setSelectedAgent}
      sandboxSlot={sandboxSlot}
    />
  );

  return (
    // A file dropped anywhere on the page attaches to the composer, as on a
    // session page.
    <ComposerDropZone className="bg-background relative flex min-h-0 flex-1 flex-col overflow-hidden lg:px-4.5">
      <ProjectHomeWallpaper />
      <SidebarToggle placement="floating" />
      <AccessRequestsBell
        count={pendingAccessCount}
        to={accessRequestsTo}
        notificationCenter={notificationCenterOn(projectDetailQuery.data?.project)}
      />
      {/* Not while the project is in its first-chat era, and not over the
          onboarding wizard: onboarding owns those screens. The era starts when
          the wizard's exit starts the first chat and then stays for the
          browser's lifetime (`first-chat-store.ts`: "Onboarding starts it, and
          it stays" — `finish` runs only on sign-out), so a wizard exit (which
          stamps the project) can never be followed by the promo popping over
          the project page the user just asked for (KRTX-2635). On later
          projects, which the create flow stamps without a wizard, the era
          never starts and the promo shows as before. */}
      {firstChatPending || !onboarded || !HomeAnnouncement ? null : <HomeAnnouncement />}

      {/* No bubble or "Thinking" row is painted here on send. The page stays
          the welcome screen with the sentence held in the composer until the
          create resolves and the session route opens; the instant shell draws
          the first turn there (`useFirstPromptPreviewStore`). Painting the turn
          here left a slow or stuck create looking like a live session. */}
      {firstChat ? (
        <FirstChat
          projectId={projectId}
          inviteTo={canManageMembers ? accessRequestsTo : null}
          composer={composer}
          busy={creating}
          // Both starters send at once, each into a new session. Through the
          // composer's own submit, not `sendOutsideComposer`: the send carries
          // the agent and model the composer shows, and a missing model refuses
          // it the same way a typed message is refused.
          onRecommendTools={() =>
            setPrefill({ text: tFirstChat('toolsPrompt'), id: Date.now(), submit: true })
          }
          onUpdateMemory={() =>
            setPrefill({ text: tFirstChat('memoryPrompt'), id: Date.now(), submit: true })
          }
        />
      ) : (
        <ProjectHomeWelcomeBody
          projectId={projectId}
          onPickSuggestion={applySuggestion}
          composer={composer}
        />
      )}
    </ComposerDropZone>
  );
}
