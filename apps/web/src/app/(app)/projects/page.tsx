import { ProjectSelector } from '@/features/workspace/project-selector/project-selector';

/**
 * `/projects` — the project selector: create a project, join an invite, or
 * open any project in any account the user belongs to. The landing door
 * (`/projects/start`) sends the user here whenever it has no single obvious
 * project to open.
 */
export default function ProjectsPage() {
  return <ProjectSelector />;
}
