import {
  ArrowCircleUpIcon as ArrowUpCircle,
  ShippingContainerIcon as Container,
  FlaskIcon as Flask,
  TrayIcon as Inbox,
  GearSixIcon as Settings,
  type Icon,
} from '@phosphor-icons/react';

import type { CustomizeSection } from '@/lib/project-actions';

/**
 * The project-configuration sections of `/projects/[id]/config` — the
 * "Settings" tab of the Customize bar.
 *
 * These six sections used to be part of the `Workspace` and `Agent` groups of
 * the Settings overlay's rail (`features/workspace/settings/rail.ts`), plus
 * its pinned Upgrades row and its `experimental` row. All of them configure a
 * PROJECT, and every one of them is reachable by exactly the people who can
 * already see Customize — so they belong on the Customize bar, not behind a
 * separate gear icon with a separate rail. The overlay keeps only what is
 * genuinely account- or user-scoped (You / Organization / API keys).
 *
 * Models, Secrets, and Members are NOT here — each graduated out of this page
 * and into its own top-level Customize tab (`models`, `secrets`, `members` in
 * `capability-tab-routes.ts`), a decision a project needs often enough that it
 * should not be one level deep in a settings sub-nav. Channels made the same
 * exit and then kept going: it is a scope of the Connectors page
 * (`channelsHref`), not a tab of its own. Repositories is NOT here either — its content merged into
 * General under a "Git repo" section (`git-view.tsx`, rendered by
 * `general-tab.tsx`'s `gitRepoSlot`); it was never its own top-level concept,
 * just a workspace detail. Marketplace was removed from this surface outright
 * (not relocated) at the product owner's explicit request — Review and Voice
 * stay, flag-gated exactly as they were on the old rail; nothing else pointed
 * at Marketplace, but the sidebar's change-requests nav still links to Review
 * (`project-sidebar/footer/project-change-requests-nav.tsx`), so dropping it
 * too would have broken a live row, not just tidied a list. Sandbox templates
 * and Snapshots were merged into one `sandbox` section — a snapshot IS the
 * build history of a sandbox template, not a separate concept.
 *
 * Labels, descriptions and docs links are carried over verbatim from the rail
 * rows they replace. The one rename is `experimental` -> `feature-flags`,
 * which is what the pane is called everywhere else in the codebase (it is
 * already the `CustomizeSection` id, see `lib/project-actions.ts`).
 *
 * A `key` IS its `?section=` query value, so renaming one breaks live links.
 * `settings-tabs.ts`'s `GRADUATED` map points every retired `SettingsTab` id
 * at the key below that replaced it.
 */
export type ProjectSettingsSectionKey =
  | 'general'
  | 'sandbox'
  | 'review'
  | 'feature-flags'
  | 'upgrades';

/**
 * **One flat list, no headings.** The sub-nav used to carry the rail's three
 * group labels — `Workspace`, `Agent`, `Advanced` — over six to eight rows.
 * Jay's call (2026-08-17): "you don't need the categories … make sure it's
 * just a regular settings thing". Three headings over six rows is more
 * chrome than list, and the grouping told a reader nothing the row labels did
 * not already say. The order below IS the sub-nav order; nothing re-sorts it.
 */
export interface ProjectSettingsSection {
  key: ProjectSettingsSectionKey;
  label: string;
  /** One line saying what the section is for, shown under the sub-nav label's
   *  pane heading. Same copy the rail row carried. */
  description?: string;
  /** The docs page that explains this section. */
  docsHref?: string;
  icon: Icon;
  /**
   * The IAM gate this section's visibility follows, via
   * `isCustomizeSectionVisible`. Identical to the mapping
   * `settings-panel.tsx`'s `GATED_TAB_SECTION` used for the same rows, so
   * moving the rows here changes who sees what by nothing.
   */
  gate: CustomizeSection;
}

/** The sections every project shows, in sub-nav order. */
const STATIC_SECTIONS: readonly ProjectSettingsSection[] = [
  {
    key: 'general',
    label: 'General',
    icon: Settings,
    gate: 'settings',
  },
  {
    key: 'sandbox',
    label: 'Sandbox templates',
    icon: Container,
    // Combines the old Sandbox templates AND Snapshots panes — a snapshot is
    // the build history of a sandbox template, not a separate concept, so one
    // section shows the template's recipe and the record of each time Kortix
    // built a machine from it.
    description:
      'The recipe for the machine a session runs on, and the record of every time Kortix prepared one.',
    docsHref: '/docs/work/runtime',
    gate: 'sandbox',
  },
];

const FEATURE_FLAGS_SECTION: ProjectSettingsSection = {
  key: 'feature-flags',
  label: 'Feature flags',
  icon: Flask,
  description: 'Features you can switch on before they are generally available.',
  gate: 'feature-flags',
};

/**
 * Upgrades — the agent-driven codebase upgrade runner. Not billing: it opens a
 * change request against this workspace's own repo. It sat pinned at the
 * bottom of the old rail and keeps that position here, last in the list.
 */
const UPGRADES_SECTION: ProjectSettingsSection = {
  key: 'upgrades',
  label: 'Upgrades',
  description:
    'Changes an agent makes to this workspace. Every run opens a change request for you to review — nothing merges on its own.',
  icon: ArrowUpCircle,
  gate: 'upgrade',
};

const REVIEW_SECTION: ProjectSettingsSection = {
  key: 'review',
  label: 'Review',
  icon: Inbox,
  description: 'Work waiting on a person before it can continue.',
  gate: 'review',
};

export interface ProjectSettingsSectionFlags {
  reviewEnabled: boolean;
}

/**
 * The sub-nav, composed from the static sections plus every flag-gated one.
 * Marketplace is gone for good — not a flag, removed from the product. Review
 * and Voice are the two still-flag-gated rows left; each is pushed in its own
 * pass, never on an early return, the exact bug the old rail documented
 * (Marketplace defaulting on for effectively every project made an early
 * return skip Review and Voice entirely).
 */
export function projectSettingsSections(
  flags: ProjectSettingsSectionFlags,
): readonly ProjectSettingsSection[] {
  const sections = [...STATIC_SECTIONS];
  if (flags.reviewEnabled) sections.push(REVIEW_SECTION);
  sections.push(FEATURE_FLAGS_SECTION, UPGRADES_SECTION);
  return sections;
}

/** Every section, independent of any flag — for copy lookups and tests. */
export const ALL_PROJECT_SETTINGS_SECTIONS: readonly ProjectSettingsSection[] =
  projectSettingsSections({ reviewEnabled: true });

/**
 * The section a `?section=` value names. `general` is the default because it
 * survives every flag and is what a person opening project settings most often
 * wants.
 */
export const DEFAULT_PROJECT_SETTINGS_SECTION: ProjectSettingsSectionKey = 'general';

export function parseProjectSettingsSection(
  raw: string | null | undefined,
): ProjectSettingsSectionKey | null {
  if (!raw) return null;
  const hit = ALL_PROJECT_SETTINGS_SECTIONS.find((s) => s.key === raw);
  return hit ? hit.key : null;
}

/** The canonical link to one section. The default section carries no query. */
export function projectSettingsSectionHref(
  projectId: string,
  key: ProjectSettingsSectionKey,
): string {
  return key === DEFAULT_PROJECT_SETTINGS_SECTION
    ? `/projects/${projectId}/config`
    : `/projects/${projectId}/config?section=${key}`;
}

/** The copy for one section, independent of any flag — used by pane headings. */
export function projectSettingsSection(
  key: ProjectSettingsSectionKey,
): ProjectSettingsSection | undefined {
  return ALL_PROJECT_SETTINGS_SECTIONS.find((s) => s.key === key);
}
