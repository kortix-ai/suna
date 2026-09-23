/**
 * `/projects/[id]/sessions` — every session of the project, opened from the
 * drawer. The project stack (ProjectScreen) registers this route and provides
 * the project through ProjectRouteProvider. See ProjectSessionsPage.
 */
import { ProjectSessionsPage } from '@/components/session/ProjectSessionsPage';

export default function ProjectSessionsScreen() {
  return <ProjectSessionsPage />;
}
