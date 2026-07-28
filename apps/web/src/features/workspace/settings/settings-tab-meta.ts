/**
 * The title and the ONE line of description each Settings tab shows.
 *
 * Settings used to be a nested rail inside the Customize overlay, and every
 * body carried its own `CustomizeSectionWrapper` heading — so the screen showed
 * "Settings" and then "Settings / Manage your project settings" directly under
 * it. The header belongs to the screen shell (`ProjectSectionPage`), not to the
 * body, so it lives here: one row per tab, one line each.
 *
 * `bodyOwnsHeader` is the migration seam. A body that still renders its own
 * `CustomizeSectionWrapper` heading keeps owning the header until it is
 * migrated — wrapping it in `ProjectSectionPage` today would stack two titles.
 * Flip the flag to `false` in the same change that strips a body's wrapper.
 * Nothing is hidden either way: every tab renders the same view it always did.
 */

import type { ProjectSettingsTab } from '@/lib/project-nav';

export interface SettingsTabMeta {
  /** The screen's single `<h1>`. */
  title: string;
  /** ONE line, at most {@link MAX_SETTINGS_DESCRIPTION_CHARS} characters. */
  description: string;
  /** True while the tab body still renders its own heading. */
  bodyOwnsHeader: boolean;
}

/** Same budget `description-length.test.ts` enforces on ProjectSectionPage. */
export const MAX_SETTINGS_DESCRIPTION_CHARS = 90;

export const SETTINGS_TAB_META: Record<ProjectSettingsTab, SettingsTabMeta> = {
  general: {
    title: 'General',
    description: 'Project name, experimental features, and the danger zone.',
    bodyOwnsHeader: false,
  },
  members: {
    title: 'Members',
    description: 'Control who can open this project and what they can change.',
    bodyOwnsHeader: true,
  },
  environment: {
    title: 'Environment',
    description: 'Variables and secrets every session in this project can read.',
    bodyOwnsHeader: true,
  },
  repository: {
    title: 'Repository',
    description: 'The repository behind every session, and how to clone it locally.',
    bodyOwnsHeader: false,
  },
  sandbox: {
    title: 'Sandbox',
    description: 'The image and template new sessions boot from.',
    bodyOwnsHeader: true,
  },
  models: {
    title: 'Models',
    description: 'Providers, routing, budgets, and API keys for the LLM gateway.',
    bodyOwnsHeader: true,
  },
  upgrades: {
    title: 'Upgrades',
    description: 'Move this project to the current Kortix configuration format.',
    bodyOwnsHeader: true,
  },
};

export function settingsTabMeta(tab: ProjectSettingsTab): SettingsTabMeta {
  return SETTINGS_TAB_META[tab];
}
