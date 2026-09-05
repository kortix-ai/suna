'use client';

import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';

import { ComposerChatInput, type ComposerOptions } from '@/features/session/composer-chat-input';
import type { DraftScope } from '@/features/session/composer/draft/composer-draft';
import type { AttachedFile } from '@/features/session/session-chat-input';
import { useSidebar } from '@/components/ui/sidebar';
import { SidebarToggle } from '@/features/workspace/project-layout/sidebar-toggle';
import { cn } from '@/lib/utils';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';
import { SubprojectSelector } from '@/features/subprojects/subproject-selector';
import { useProjectSubprojects } from '@/features/subprojects/subprojects-data';
import { useComposerPrefillStore } from '@/stores/composer-prefill-store';
import {
  type SandboxTemplate,
  type Subproject,
  getProjectDetail,
  listProjectAccessRequests,
  listProjectSandboxes,
} from '@kortix/sdk';
import { contract, qk, type Command } from '@kortix/sdk/react';
import { META_SANDBOX_SLUG, isMetaAgentName } from '@kortix/shared';
import { AccessRequestsBell } from './home/access-requests-bell';
import { MetaRuntimeIndicator } from './home/meta-runtime-indicator';
import { SandboxPicker } from './home/sandbox-picker';
import {
  type ProjectHomeHero,
  ProjectHomeWallpaper,
  ProjectHomeWelcomeBody,
} from './home/welcome-body';

// This path is this view's public surface — the instant session shell and the
// IAM tests already import from here, so the moved pieces keep their address.
export { ProjectHomeWelcomeBody } from './home/welcome-body';
export { PROJECT_SETUP_TILE_ACTIONS } from './home/setup-tiles';

export interface ProjectHomeSendOptions extends ComposerOptions {
  sandbox_slug?: string;
  /** Where the session starts: a subproject slug, or `null` for the whole project. */
  subproject?: string | null;
  /** That subproject's own `agent` — the boot agent when the composer picked none. */
  subproject_agent?: string | null;
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
  hero,
  below,
  breadcrumb,
  toolbar,
  subproject,
}: {
  projectId: string;
  onSend: (
    text: string,
    files: AttachedFile[] | undefined,
    options?: ProjectHomeSendOptions,
  ) => void;
  busy: boolean;
  /** See `ProjectHomeWelcomeBody` — a subproject wears this surface with its own name. */
  hero?: ProjectHomeHero;
  /** Rendered under the composer, inside the hero column. */
  below?: ReactNode;
  /** Floated over the top-left corner, beside the sidebar toggle. */
  breadcrumb?: ReactNode;
  /** Floated over the top-right corner, ahead of the access-requests bell. */
  toolbar?: ReactNode;
  /** The subproject this page IS (a subproject page) — the picker's default. */
  subproject?: Subproject | null;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const sidebarCollapsed = useSidebar().state === 'collapsed';

  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [prefill, setPrefill] = useState<{ text: string; id: number } | null>(null);

  // Where a send starts. The page's own subproject is the default; a pick on
  // the composer overrides it. The pick remembers which page it was made on,
  // so moving between subproject pages never carries a stale choice across.
  const pageSubproject = subproject?.slug ?? null;
  const [subprojectPick, setSubprojectPick] = useState<{
    page: string | null;
    slug: string | null;
  } | null>(null);
  const activeSubproject =
    subprojectPick?.page === pageSubproject ? subprojectPick.slug : pageSubproject;
  // The SAME query the sidebar group reads — never a second request.
  const subprojectsQuery = useProjectSubprojects(projectId);
  const subprojects = useMemo(() => {
    const list = subprojectsQuery.data?.subprojects ?? [];
    // The page's own row must exist before the list lands, or the trigger
    // would read "Subproject" on a page that is already inside one.
    return subproject && !list.some((s) => s.slug === subproject.slug)
      ? [subproject, ...list]
      : list;
  }, [subprojectsQuery.data, subproject]);
  const activeSubprojectAgent =
    subprojects.find((s) => s.slug === activeSubproject)?.agent ?? null;
  const canCreateSubproject =
    useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_CUSTOMIZE_WRITE).allowed === true;

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
        subproject: activeSubproject,
        subproject_agent: activeSubprojectAgent,
        ...(metaSelected
          ? { sandbox_slug: META_SANDBOX_SLUG }
          : selectedSlug
            ? { sandbox_slug: selectedSlug }
            : {}),
      });
    },
    [metaSelected, selectedSlug, onSend, activeSubproject, activeSubprojectAgent],
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
      {breadcrumb ? (
        // `left-12` clears the floating sidebar toggle (`top-2 left-2`, 32px)
        // while the sidebar is collapsed; expanded, the toggle is gone and the
        // breadcrumb takes its place on the rail.
        <div
          className={cn(
            'absolute top-3.5 z-20 flex min-w-0 items-center',
            sidebarCollapsed ? 'left-12' : 'left-4',
          )}
        >
          {breadcrumb}
        </div>
      ) : null}
      {/* One top-right cluster: the host's toolbar, then the bell — both are
          `static` inside it so neither has to know about the other. */}
      <div className="absolute top-3 right-4 z-20 flex items-center gap-1">
        {toolbar}
        <AccessRequestsBell
          count={pendingAccessCount}
          href={accessRequestsHref}
          className="static top-auto right-auto"
        />
      </div>

      <ProjectHomeWelcomeBody
        projectId={projectId}
        onPickSuggestion={applySuggestion}
        hero={hero}
        below={below}
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
            // The tray under the card: where the session starts (user,
            // 2026-09-05 — "under the main chat box, like Claude's project or
            // folder strip"). Absent until the project has a subproject to
            // offer — a picker over nothing can only say "Whole project".
            traySlot={
              subprojects.length > 0 ? (
                <SubprojectSelector
                  projectId={projectId}
                  subprojects={subprojects}
                  selected={activeSubproject}
                  onSelect={(slug) => setSubprojectPick({ page: pageSubproject, slug })}
                  canCreate={canCreateSubproject}
                />
              ) : null
            }
          />
        }
      />
    </div>
  );
}
