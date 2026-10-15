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
import { useProjectPageCans } from '@/lib/use-project-can';
import { useFeatureFlag } from '@kortix/sdk/react';

export const TAB_PREFERENCE: readonly { key: CapabilityTab['key']; action: string }[] = [
  // Agents lead the bar (Marko, 2026-09-01): an agent is the object a person
  // is granted, so the row lands on the list of them. Skills — the other
  // thing you build — follows. Both keep the read leaves they always had.
  { key: 'agent', action: PROJECT_ACTIONS.PROJECT_AGENT_READ },
  { key: 'skills', action: PROJECT_ACTIONS.PROJECT_SKILL_READ },
  { key: 'connectors', action: PROJECT_ACTIONS.PROJECT_CONNECTOR_READ },
  // Triggers covers both schedules and webhooks — two views of one resource,
  // a project trigger — so it has one leaf. `project.trigger.read` is in
  // PROJECT_MEMBER_BASELINE (apps/api/src/iam/role-perms.ts), so every project
  // role that could open these panes in the Settings overlay still can here.
  { key: 'triggers', action: PROJECT_ACTIONS.PROJECT_TRIGGER_READ },
  // Models and Secrets graduated out of the Settings overlay's sub-nav onto
  // their own top-level tabs. Their read leaves are carried over unchanged
  // from `lib/project-actions.ts`'s `CUSTOMIZE_SECTION_ACCESS` map
  // (`llm-management` -> project.read, `secrets` -> secret.read) — moving
  // The Models tab is model routing: project.model.read.
  { key: 'models', action: PROJECT_ACTIONS.PROJECT_MODEL_READ },
  // Channels is NOT a row here any more. It is a scope of the Connectors page
  // (`channelsHref`), and it always gated on `project.connector.read` — the
  // same leaf the Connectors row above already probes, so folding it in
  // removed a duplicate probe rather than a gate.
  { key: 'secrets', action: PROJECT_ACTIONS.PROJECT_SECRET_READ },
  // Files is the project's shared folders. Anyone who can read the project
  // may open it; what each person sees in it follows folder access, decided
  // by the drives API per folder.
  { key: 'files', action: PROJECT_ACTIONS.PROJECT_READ },
  // Settings (`/projects/<id>/config`) holds the project configuration that
  // did not earn its own top-level tab: project.settings.write.
  { key: 'config', action: PROJECT_ACTIONS.PROJECT_SETTINGS_WRITE },
];

/**
 * First tab the caller may open, or null when every one of them is an explicit
 * deny. Optimistic while a probe loads — same rule as ProjectFilesNavItem: the
 * entry only disappears on a denial we actually received.
 *
 * The probes are unconditional and fixed-order on purpose. Hooks cannot
 * be called from a loop that short-circuits.
 */
export function useCapabilityTab(projectId: string | undefined): CapabilityTab['key'] | null {
  // ONE request. These used to be seven `useProjectCan` singles, and each one
  // is its own `GET …/iam/members/:me/effective?action=…` plus a CORS
  // preflight — fourteen round trips on every project page open, for a
  // sidebar row. `useCans` sends the list to `effective:batch` and answers all
  // seven from one response; the order below is still the preference order.
  const results = useProjectPageCans(projectId);
  const hit = TAB_PREFERENCE.findIndex((tab) => {
    const probe = results[tab.action];
    return !!probe && (probe.allowed || probe.isLoading);
  });
  return hit === -1 ? null : TAB_PREFERENCE[hit].key;
}

export function ProjectCustomizeNavItem() {
  const t = useTranslations('sidebar');
  const pathname = usePathname();
  const params = useParams<{ id: string }>();
  const projectId = params?.id;
  const tab = useCapabilityTab(projectId);
  // Files lives under Customize, so its open conflict copies (in folders the
  // caller can see) badge this row: the sidebar keeps no Files row of its own.
  const tDrives = useTranslations('drives');
  const drivesGate = useFeatureFlag(projectId, 'drives');
  const drive = useProjectDrive(projectId, drivesGate.enabled);
  const conflicts = drivesGate.enabled ? (drive.data?.openConflicts ?? 0) : 0;
  // Active on the legacy index (`/customize`, for the instant before it
  // redirects) AND on any capability tab — the row stays lit while browsing
  // Connectors or one agent's page, not just on the landing tab.
  const isActive =
    !!pathname &&
    (pathname === `/projects/${projectId}/customize` || activeCapabilityTab(pathname) !== null);

  // The row exists when the caller may open at least one tab: each tab is
  // gated on its own read leaf (`useCapabilityTab`), there is no surface gate.
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
      {conflicts > 0 ? (
        <CountBadge
          count={conflicts}
          tone="conflict"
          className="ml-auto"
          aria-label={tDrives('conflictCount', { count: conflicts })}
        />
      ) : null}
    </ProjectNavRow>
  );
}
