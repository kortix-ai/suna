import { listTenantProjects } from './binding';
import { buildHomeCard } from './cards';
import { projectRows } from './project-rows';

/**
 * `/home`, and the card a personal install gets: the organization's projects
 * and what to try. Its own module so the install path in `dispatch.ts` does
 * not import the command surface.
 */
export async function buildTeamsHomeCard(tenantId: string, onlyProjectId?: string): Promise<Record<string, unknown>> {
  const projects = (await listTenantProjects(tenantId).catch(() => [])).filter(
    (p) => !onlyProjectId || p.projectId === onlyProjectId,
  );
  return buildHomeCard({ projects: await projectRows(projects) });
}
