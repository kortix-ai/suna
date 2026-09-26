/**
 * `/projects/[id]/page?pageId=…` — a sub-page pushed over the page it was
 * opened from: project Settings from Settings, Schedules or Secrets from
 * project Settings. See ProjectSubPageRoute.
 */
import { ProjectSubPageRoute } from '@/components/session/ProjectRoutes';

export default function ProjectSubPageScreen() {
  return <ProjectSubPageRoute />;
}
