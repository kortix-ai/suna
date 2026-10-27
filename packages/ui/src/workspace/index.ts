/**
 * @kortix/ui/workspace — Composed project screens: the session workspace (thread +
 * resizable side panel), the project sidebar, sessions list, project home, and the
 * permission and route helpers they share.
 */
// NOTE: ProjectAdminDashboard is intentionally NOT re-exported here. It pulls
// every capability data hook (connectors/triggers/reminders/models/secrets/
// review); since Turbopack does not tree-shake this barrel in dev, re-exporting
// it made all ~44 routes that import `@kortix/ui/workspace` compile that graph.
// The /admin route imports it directly from '@kortix/ui/workspace/admin/project-admin-dashboard'.
export { ProjectPageHeader } from '../internal/layout/project-page-header';
export { useCapabilityAccess, useProjectNavRows } from '../internal/layout/project-settings-nav';
export { SidebarToggle } from '../internal/layout/sidebar-toggle';
export {
  activeCapabilityTab,
  agentHref,
  capabilityTabHref,
  channelsHref,
  remindersHref,
  reviewHref,
} from '../internal/lib/capability-tab-routes';
export {
  detectManifestVersion,
  manifestFilename,
  manifestNeedsUpgrade,
  useProjectManifestVersion,
  type ManifestVersion,
} from '../internal/lib/manifest-version';
export {
  CUSTOMIZE_SECTION_ACCESS,
  CUSTOMIZE_SECTION_GATE_ACTIONS,
  PROJECT_ACTIONS,
  isCustomizeSectionVisible,
  type CustomizeSection,
  type ProjectAction,
} from '../internal/lib/project-actions';
export { usePermission, usePermissions, usePermissionsFor } from '../internal/lib/use-permission';
export {
  PROJECT_PAGE_ACTIONS,
  useProjectCan,
  useProjectCans,
  useProjectPageCans,
  type CanResult,
} from '../internal/lib/use-project-can';
export {
  formatFireTime,
  nearestFire,
  reminderTitle,
  scheduleLabel,
} from '../internal/reminders/reminder-format';
export { ProjectHomeWallpaper, ProjectHomeWelcomeBody } from './home/welcome-body';
export { InstantSessionShell } from './instant-session-shell';
export { ProjectFilesView } from './layout/project-files-view';
export { ProjectHome, type ProjectHomeSendOptions } from './layout/project-home';
export { useProjectHomeSend, type UseProjectHomeSendOptions } from './layout/use-project-home-send';
export { SavedSessionSkeleton } from './saved-session-skeleton';
export {
  SessionLayout,
  SessionWorkspace,
  type SessionLayoutProps,
  type SessionWorkspaceProps,
} from './session-workspace';
export { ProjectSessionsView } from './sessions/project-sessions-view';
export { SpaceView, type SpaceFolder, type SpaceTarget, type SpaceViewProps } from './spaces/space-view';
export { ChannelGlyph } from './spaces/channel-glyph';
export { agentLabel } from './spaces/space-timeline';
export { MemoryView, type MemoryViewProps } from './memory/memory-view';
export { type MemoryLayerRef, useMemoryPageHref } from '../internal/lib/memory-href';
export { CompanyMemoryPage } from './memory/company-memory-page';
export { ProjectSessionList } from './sidebar/project-session-list';
export { ProjectSidebar } from './sidebar/project-sidebar';
export { ShareSessionModal } from './sidebar/modal/share-session-modal';
export {
  formatGoalTime,
  GoalHealthDot,
  goalHref,
  goalNeedsYou,
  goalOpenAsks,
  goalProgress,
  GoalStatusBadge,
  useGoalClock,
  useGoalIssueText,
} from '../internal/goals/goal-meta';
// Spaces: the per-viewer active space and the space filter the Goals and Artifacts pages share.
export { useActiveSpace } from '../internal/stores/active-space-store';
export { ALL_SPACES } from '../customize/shared/catalog/catalog-space-tabs';
export { SpaceFilterTabs, spaceFilterLabel } from './space/space-filter-tabs';
export { useSpaceFilter } from './space/use-space-filter';
