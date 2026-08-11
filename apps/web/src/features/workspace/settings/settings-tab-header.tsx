/**
 * The page heading for a settings pane — the tab's own name and one line
 * saying what it is for, rendered above that pane's content.
 *
 * **Why this exists.** Every tab used to open straight onto its first
 * *section* heading — Profile began at "Name", Preferences at "Theme",
 * Billing at "Plan, wallet and spend" — and Audit had no heading at all. So
 * nothing on the pane told you which tab you were looking at; the only cue
 * was the selected row in the rail, which is easy to lose track of on a
 * 27-tab panel and invisible once the rail scrolls.
 *
 * **Why the copy comes from the rail rather than a prop.** `label` and
 * `description` live together on `RailItem` (`./type.ts`), so the pane
 * heading and the rail row can never disagree, and adding a tab means
 * writing its copy exactly once. It also settles a real ambiguity: two tabs
 * are both labelled "General" — Workspace › General and Organization ›
 * General. In the rail the group heading separates them; in a pane heading
 * there is no group, so the description is what tells them apart.
 *
 * Rendered INSIDE each tab's own container rather than by the panel shell,
 * because the panel's two content widths (`max-w-2xl` for forms, `max-w-4xl`
 * for tables — see `tab-content-width.test.ts`) are owned per tab. A heading
 * hoisted into the shell would sit in a container of its own and could not
 * line up with the content beneath it at both widths.
 */

import { SettingsSectionHeader } from '@/components/ui/settings-section-header';

import { railItemForTab } from './rail';
import type { SettingsTab } from './settings-tabs';

export function SettingsTabHeader({ tab, action }: { tab: SettingsTab; action?: React.ReactNode }) {
  const item = railItemForTab(tab);
  if (!item) return null;

  return (
    <SettingsSectionHeader
      title={item.label}
      description={item.description}
      action={action}
      // A page heading, not a section heading. `pb-1` gives it a little more
      // air than the sections below it get from the container's `space-y-*`,
      // so the eye reads it as the pane's title rather than as the first of
      // several equal-weight sections.
      className="pb-1"
    />
  );
}
