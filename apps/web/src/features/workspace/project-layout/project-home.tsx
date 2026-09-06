'use client';

import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { ComposerChatInput, type ComposerOptions } from '@/features/session/composer-chat-input';
import type { DraftScope } from '@/features/session/composer/draft/composer-draft';
import type { AttachedFile } from '@/features/session/session-chat-input';
import { SidebarToggle } from '@/features/workspace/project-layout/sidebar-toggle';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';
import { useComposerPrefillStore } from '@/stores/composer-prefill-store';
import {
  type SandboxTemplate,
  getProjectDetail,
  listProjectAccessRequests,
  listProjectSandboxes,
} from '@kortix/sdk';
import { contract, qk, type Command } from '@kortix/sdk/react';
import { META_SANDBOX_SLUG, isMetaAgentName } from '@kortix/shared';
import { AccessRequestsBell } from './home/access-requests-bell';
import { MetaRuntimeIndicator } from './home/meta-runtime-indicator';
import { SandboxPicker } from './home/sandbox-picker';
import { ProjectHomeWallpaper, ProjectHomeWelcomeBody } from './home/welcome-body';

// This path is this view's public surface — the instant session shell and the
// IAM tests already import from here, so the moved pieces keep their address.
export { ProjectHomeWelcomeBody } from './home/welcome-body';
export { PROJECT_SETUP_TILE_ACTIONS } from './home/setup-tiles';

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
  ) => void;
  busy: boolean;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');

  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [prefill, setPrefill] = useState<{ text: string; id: number } | null>(null);

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
  const accessRequestsHref = accountId
    ? `/accounts/${accountId}?tab=access-projects&project=${projectId}`
    : null;

  const handleSend = useCallback(
    (text: string, files: AttachedFile[] | undefined, options: ComposerOptions) => {
      onSend(text, files, {
        ...options,
        ...(metaSelected
          ? { sandbox_slug: META_SANDBOX_SLUG }
          : selectedSlug
            ? { sandbox_slug: selectedSlug }
            : {}),
      });
    },
    [metaSelected, selectedSlug, onSend],
  );

  const pendingPrefill = useComposerPrefillStore((s) => s.prefillByProject[projectId]);
  const consumePrefill = useComposerPrefillStore((s) => s.consume);

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
      handleSend(pendingPrefill.text, undefined, {});
      return;
    }
    setPrefill({ text: pendingPrefill.text, id: Date.now() });
  }, [pendingPrefill, projectId, consumePrefill, handleSend]);

  const handleCommand = useCallback(
    (cmd: Command, args: string | undefined, options: ComposerOptions) => {
      handleSend(`/${cmd.name}${args ? ` ${args}` : ''}`, undefined, options);
    },
    [handleSend],
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
      <ProjectHomeWallpaper />
      <SidebarToggle placement="floating" />
      <AccessRequestsBell count={pendingAccessCount} href={accessRequestsHref} />

      <ProjectHomeWelcomeBody
        projectId={projectId}
        onPickSuggestion={applySuggestion}
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
            // The home composer navigates to the new session on send — don't
            // clear it first (that only flashes an empty box before the route
            // swaps, and would drop the text on a gated send). The message
            // rides across via the start-stash and reappears as the instant
            // shell's optimistic turn.
            clearOnSend={false}
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
