/**
 * Where a workspace setting lives in the app, in the app's own words. The
 * section ids, labels and path come from the one Settings panel's registry
 * (`@kortix/shared/workspace-settings`), so a renamed or moved section never
 * leaves a stale "go to …" line in the CLI.
 */
import {
  WORKSPACE_SETTINGS_LABELS,
  type WorkspaceSettingsSection,
  workspaceSettingsPath,
} from '@kortix/shared/workspace-settings';

/** The Settings panel's name in the workspace menu. */
export const SETTINGS_PANEL = 'Workspace settings';

/** "Workspace settings → Feature flags". */
export function settingsWhere(section: WorkspaceSettingsSection): string {
  return `${SETTINGS_PANEL} → ${WORKSPACE_SETTINGS_LABELS[section]}`;
}

/** The absolute app link of one section: `<web origin>/workspaces/<id>/admin/<section>`. */
export function settingsUrl(webOrigin: string, workspaceId: string, section: WorkspaceSettingsSection): string {
  return `${webOrigin.replace(/\/+$/, '')}${workspaceSettingsPath(workspaceId, section)}`;
}
