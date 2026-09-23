/**
 * `/projects/[id]/account` — the Account page inside the project, opened from
 * the drawer avatar. Same page as the Account tab, with a hamburger header
 * that opens the project drawer, so Sign out, Billing and Accounts are
 * reachable without leaving the project.
 */
import { useCoveringRoute, useProjectRoute } from '@/components/session/ProjectRoutes';
import { AccountPage } from '@/components/settings/AccountPage';

export default function ProjectAccountScreen() {
  const { openDrawer } = useProjectRoute();
  // A session opened from the drawer replaces this page with the view.
  useCoveringRoute();

  return <AccountPage presentation="project" onOpenMenu={openDrawer} />;
}
