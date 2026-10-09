/**
 * `/projects/[id]/inbox` — the caller's notifications across every project
 * (KRTX-1742), opened from the drawer's Notifications pill. The project stack
 * (ProjectScreen) registers this route and provides the project through
 * ProjectRouteProvider. See InboxPage.
 */
import { InboxPage } from '@/components/notifications/InboxPage';

export default function ProjectInboxScreen() {
  return <InboxPage />;
}
