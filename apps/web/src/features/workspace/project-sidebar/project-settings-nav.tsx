'use client';

import { ProjectNavRow } from '@/features/workspace/project-sidebar/project-nav-row';

import { CustomizeGlyph } from '@/features/icon/icons/customize';
export { CustomizeGlyph } from '@/features/icon/icons/customize';

import { useTranslations } from '@/i18n/use-translations';
import { useParams, usePathname } from 'next/navigation';

import { CountBadge } from '@/components/ui/count-badge';
import {
  activeCapabilityTab,
  capabilityTabHref,
  type CapabilityTab,
} from '@/features/workspace/capabilities/shared/capability-tab-routes';
import { useProjectDrive } from '@/hooks/drives/use-drives';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useFeatureFlag } from '@kortix/sdk/react';
import { useProjectPageCans, type CanResult } from '@/lib/use-project-can';
import { useReviewSessionSummary } from '@/features/review-center/hooks/use-review-session-summary';

/**
 * The one project-configuration entry in the sidebar:
 * ProjectCustomizeNavItem, top of the panel under New session, navigating to
 * the capability pages (Models / Connectors / Agents / Skills / Triggers /
 * Secrets / Settings). Gated, because those pages can 403.
 *
 * The bottom-of-footer "Settings" row that used to sit beside it is gone
 * (Jay, 2026-08-17): it opened the same User Settings overlay a click on the
 * workspace switcher already opens, one level up — a second row to an
 * identical destination. The overlay itself, and its Mod+, keyboard
 * shortcut, are unchanged; only this row's `<SidebarMenuItem>` is gone. The
 * shortcut moved out of this file on 2026-09-02 — it now sits with the surface
 * it opens (`settings/settings-shortcut.ts`, mounted by `SettingsPanel`), so
 * it binds wherever the panel is mounted rather than wherever this sidebar is.
 * The keycap it advertises is printed on `workspace-switcher.tsx`'s "Settings"
 * row, which is the row that opens the same overlay.
 */

/**
 * The tab the Customize row lands on, in preference order. **This mirrors
 * `CAPABILITY_TABS`** — the row should land on the first tab of the bar it
 * navigates into, so reordering the bar cannot leave this pointing at the
 * second one.
 *
 * The fallbacks exist because each tab carries its own IAM leaf: a caller
 * denied `project.connector.read` but allowed `project.skill.read` still gets
 * a working row, rather than a link to a page that 403s.
 *
 * Commands is intentionally absent: its standalone capability page was removed,
 * so there is no `/projects/<id>/commands` route to land on. Commands stays
 * reachable through the Customize overlay (`/customize/commands` via the
 * `proj-commands` palette entry and the Settings row).
 */
export const TAB_PREFERENCE: readonly {
  key: CapabilityTab['key'];
  action: string;
  /**
   * The write leaves that make the tab worth opening. Customize is where a
   * project is CONFIGURED, so a tab shows only to a caller who holds its read
   * leaf AND at least one of these. A plain project member reads agents and
   * triggers but changes neither, so both tabs (and with them the Customize
   * row) are hidden for them instead of opening onto a read-only page
   * (KRTX-2144). Absent = the read leaf alone is enough.
   */
  manage?: readonly string[];
}[] = [
  // Agents lead the bar (Marko, 2026-09-01): an agent is the object a person
  // is granted, so the row lands on the list of them. Skills — the other
  // thing you build — follows.
  {
    key: 'agent',
    action: PROJECT_ACTIONS.PROJECT_AGENT_READ,
    manage: [PROJECT_ACTIONS.PROJECT_AGENT_WRITE],
  },
  {
    key: 'skills',
    action: PROJECT_ACTIONS.PROJECT_SKILL_READ,
    manage: [PROJECT_ACTIONS.PROJECT_SKILL_WRITE],
  },
  // Channels is a scope of the Connectors page (`channelsHref`) and shares
  // its leaves.
  {
    key: 'connectors',
    action: PROJECT_ACTIONS.PROJECT_CONNECTOR_READ,
    manage: [
      PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE,
      PROJECT_ACTIONS.PROJECT_CONNECTOR_CONNECTIONS_MANAGE,
    ],
  },
  // Triggers covers both schedules and webhooks — two views of one resource,
  // a project trigger — so it has one read leaf. Firing is not configuring:
  // `project.trigger.fire` alone does not show the tab.
  {
    key: 'triggers',
    action: PROJECT_ACTIONS.PROJECT_TRIGGER_READ,
    manage: [
      PROJECT_ACTIONS.PROJECT_TRIGGER_CREATE,
      PROJECT_ACTIONS.PROJECT_TRIGGER_UPDATE,
      PROJECT_ACTIONS.PROJECT_TRIGGER_DELETE,
    ],
  },
  // The Models tab is model routing.
  {
    key: 'models',
    action: PROJECT_ACTIONS.PROJECT_MODEL_READ,
    manage: [PROJECT_ACTIONS.PROJECT_MODEL_WRITE],
  },
  {
    key: 'secrets',
    action: PROJECT_ACTIONS.PROJECT_SECRET_READ,
    manage: [PROJECT_ACTIONS.PROJECT_SECRET_WRITE],
  },
  // Files is the project's shared folders: content, not configuration. Anyone
  // who can read the project may open it; what each person sees in it follows
  // folder access, decided by the drives API per folder.
  { key: 'files', action: PROJECT_ACTIONS.PROJECT_READ },
  // The Review inbox is for the people who decide: approve a change request,
  // answer an agent. Reading without acting is not a reason to show it.
  {
    key: 'review',
    action: PROJECT_ACTIONS.PROJECT_REVIEW_READ,
    manage: [PROJECT_ACTIONS.PROJECT_REVIEW_ACT],
  },
  // Settings (`/projects/<id>/customize/settings`) is configuration by
  // definition: its read leaf is already a write leaf.
  { key: 'config', action: PROJECT_ACTIONS.PROJECT_SETTINGS_WRITE },
];

/** Every leaf `TAB_PREFERENCE` reads. `PROJECT_PAGE_ACTIONS` carries all of
 *  them, and a test asserts it, so the whole decision is one batch. */
export const CAPABILITY_TAB_ACTIONS: readonly string[] = TAB_PREFERENCE.flatMap((tab) => [
  tab.action,
  ...(tab.manage ?? []),
]);

export interface CapabilityAccess {
  /** True once every probe the decision reads has an answer. */
  settled: boolean;
  /** The tabs the caller may open, in bar order. Empty until settled. */
  tabs: CapabilityTab['key'][];
}

/**
 * The ONE Customize access rule. The sidebar row, the More menu, the tab bar,
 * the page-body gate and the `/customize` redirect all read it, so they cannot
 * disagree about a tab — and none of them acts before it settles. Each of them
 * used to apply its own loading rule (optimistic row, static bar, gate that
 * waited for a denial), which is what showed a limited member a section on one
 * visit and a "You don't have access" dead end on the next.
 *
 * A failed probe counts as settled and denied: the bar fails closed.
 *
 * `drives` is the project's `drives` flag, `undefined` while it loads. Files
 * exists only with it on, so the rule (not each surface) drops the tab.
 */
export function capabilityAccess(
  caps: Record<string, CanResult>,
  drives: boolean | undefined,
): CapabilityAccess {
  const settled =
    drives !== undefined &&
    CAPABILITY_TAB_ACTIONS.every((action) => caps[action] && !caps[action].isLoading);
  if (!settled) return { settled, tabs: [] };
  const allowed = (action: string) => caps[action]?.allowed === true;
  const tabs = TAB_PREFERENCE.filter(
    (tab) =>
      (drives || tab.key !== 'files') &&
      allowed(tab.action) &&
      (!tab.manage || tab.manage.some(allowed)),
  ).map((tab) => tab.key);
  return { settled, tabs };
}

export function useCapabilityAccess(projectId: string | undefined): CapabilityAccess {
  const caps = useProjectPageCans(projectId);
  const drives = useFeatureFlag(projectId, 'drives');
  return capabilityAccess(caps, drives.isLoading ? undefined : drives.enabled);
}

/**
 * The two sidebar rows that can lead to Files, decided together.
 *
 * The Files row is the repo browser for a caller who can read the repo
 * (`project.file.read`). With `drives` on, the shared folders are also a
 * Customize tab. A caller who cannot read the repo reaches the folders from
 * the Files row (`folders`) instead, and Customize then needs a tab other
 * than Files: a plain member never gets a Customize row that holds only their
 * folders.
 *
 * `customize` is the tab the Customize row lands on, `files` what the Files
 * row opens; null means no row. Neither row shows before the batch and the
 * flag settle.
 */
export interface ProjectNavRows {
  customize: CapabilityTab['key'] | null;
  files: 'repo' | 'folders' | null;
}

export function projectNavRows(
  access: CapabilityAccess,
  readRepo: CanResult | undefined,
): ProjectNavRows {
  if (!access.settled || !readRepo || readRepo.isLoading) return { customize: null, files: null };
  const files =
    readRepo.allowed === true ? 'repo' : access.tabs.includes('files') ? 'folders' : null;
  const customize = access.tabs.find((tab) => files !== 'folders' || tab !== 'files') ?? null;
  return { customize, files };
}

export function useProjectNavRows(projectId: string | undefined): ProjectNavRows {
  const readRepo = useProjectPageCans(projectId)[PROJECT_ACTIONS.PROJECT_FILE_READ];
  return projectNavRows(useCapabilityAccess(projectId), readRepo);
}

/**
 * Customize — the top-of-panel entry, mounted directly under New session. It
 * navigates to the FIRST capability tab the caller may open — Agents, for
 * anyone who can read them — through `capabilityTabHref`. Customize is
 * agent-centric (Marko, 2026-09-01): the agent is the object a person is
 * granted, so the row lands on the list of agents, not on a chooser page
 * that introduces seven equal tabs. The former index at `/customize` still
 * resolves — it redirects here through the same `TAB_PREFERENCE` — so every
 * bookmark, palette entry and shortcut that names it keeps working.
 *
 * Gated on ONE question: does at least one tab exist for this caller to land
 * on? `capabilityAccess()` answers it for every Customize surface — a caller
 * with no tab gets no row at all, and nobody gets the row before the answer
 * arrives, so it never shows and then vanishes.
 *
 * A real `<Link prefetch>`, not `router.push` — same reason as
 * ProjectFilesNavItem: the button form cannot be prefetched, so every click
 * pays for the RSC payload and the route chunk cold. It is hover-gated
 * (`HoverPrefetchLink`) because prefetching on mount charged every session open
 * a full dynamic render of /customize, whether or not anyone went there.
 *
 * Sliders, not a second gear: two identical gear rows in one panel read as a
 * duplicate, not as two ways in. No keycap either — Mod+, is printed on the
 * Settings row, and one shortcut advertised on two rows is a lie on one of them.
 */
export function ProjectCustomizeNavItem() {
  const t = useTranslations('sidebar');
  const pathname = usePathname();
  const params = useParams<{ id: string }>();
  const projectId = params?.id;
  const access = useCapabilityAccess(projectId);
  const rows = useProjectNavRows(projectId);
  const tab = rows.customize;
  // Review lives under Customize, so the decisions waiting on the caller badge
  // this row: the same `needs_you` count the session row dots read.
  const needsYou = useReviewSessionSummary(projectId ?? '', { enabled: !!projectId }).totalNeedsYou;
  const reviewCount = access.tabs.includes('review') ? needsYou : 0;
  // The shared folders' open conflict copies (in folders the caller can see)
  // badge the row that leads to them: this one, unless the Files row does.
  const tDrives = useTranslations('drives');
  const foldersHere = access.tabs.includes('files') && rows.files !== 'folders';
  const drive = useProjectDrive(projectId, foldersHere);
  const conflicts = foldersHere ? (drive.data?.openConflicts ?? 0) : 0;
  // Active on the legacy index (`/customize`, for the instant before it
  // redirects) AND on any capability tab — the row stays lit while browsing
  // Connectors or one agent's page, not just on the landing tab. Not on the
  // folders when the Files row is the one that opens them.
  const here = pathname ? activeCapabilityTab(pathname) : null;
  const isActive =
    !!pathname &&
    (pathname === `/projects/${projectId}/customize` ||
      (here !== null && (here !== 'files' || rows.files !== 'folders')));

  if (!tab) return null;
  // No project id means no valid href, so there is nothing to render.
  if (!projectId) return null;

  return (
    <ProjectNavRow
      active={isActive}
      label={t('customize')}
      href={capabilityTabHref(projectId, tab)}
      prefetch
    >
      <span className="shrink-0">
        <CustomizeGlyph />
      </span>
      {t('customize')}
      {reviewCount > 0 || conflicts > 0 ? (
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {reviewCount > 0 ? <CountBadge count={reviewCount} tone="waiting" /> : null}
          {conflicts > 0 ? (
            <CountBadge
              count={conflicts}
              tone="conflict"
              aria-label={tDrives('conflictCount', { count: conflicts })}
            />
          ) : null}
        </span>
      ) : null}
    </ProjectNavRow>
  );
}
