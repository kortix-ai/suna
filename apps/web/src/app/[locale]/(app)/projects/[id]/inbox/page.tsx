import { NotificationInbox } from '@kortix/ui/internal/notifications/notification-inbox';

/**
 * /projects/[id]/inbox — the Inbox (KRTX-1742) beside the project sidebar:
 * the signed-in person's notifications from every project, not only this
 * one. The sidebar's Inbox row opens it. "Notification settings" opens this
 * project's Settings overlay on the Notifications pane.
 */
export default function ProjectInboxPage() {
  return <NotificationInbox />;
}
