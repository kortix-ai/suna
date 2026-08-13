import {
  type Icon as IconMynauiType,
  type Icon as IconType,
  type Icon as LucideIcon,
} from '@phosphor-icons/react';
import type { SettingsTab } from './settings-tabs';

export interface RailItem {
  tab: SettingsTab;
  label: string;
  /**
   * One line saying what the tab is for. Rendered as the pane's page heading
   * description by `SettingsTabHeader`, beneath `label`.
   *
   * It lives here, beside the label, rather than in each tab file for two
   * reasons. It is the same string the rail could show as a tooltip, so one
   * source cannot drift from another; and it is what disambiguates the two
   * tabs both labelled "General" — Workspace › General and Organization ›
   * General. In the rail the group heading separates them. In a pane heading
   * there is no group, so the label alone is genuinely ambiguous and the
   * description is doing real work, not decoration.
   */
  description?: string;
  /**
   * The docs page that explains this tab, rendered by `SettingsTabHeader` as a
   * "Docs" button in the pane heading's action row.
   *
   * Here rather than in each tab file for the same reason as `description`: it
   * is one fact about a tab, and a tab has exactly one canonical page. Keeping
   * it beside the label means adding docs to a pane is one line of config, not
   * a hand-rolled button per tab — twenty of which would drift in variant,
   * icon, label and target within a release.
   *
   * Panes open as an overlay over live work, so the button opens in a new tab;
   * `SettingsTabHeader` owns that decision, not the caller.
   */
  docsHref?: string;
  icon?: LucideIcon | IconMynauiType | IconType;
}

export interface RailGroup {
  label: string;
  items: readonly RailItem[];
}
