import { NotificationInbox } from '@kortix/ui/internal/notifications/notification-inbox';

/**
 * /workspaces/[id]/inbox — the Inbox (KRTX-1742) beside the workspace
 * sidebar: the signed-in person's notifications from every workspace, not
 * only this one. The sidebar's Inbox row opens it. "Notification settings"
 * opens this workspace's Settings overlay on the Notifications pane.
 */
export default function WorkspaceInboxPage() {
  return <NotificationInbox />;
}
