import { eq } from 'drizzle-orm';
import { projects } from '@kortix/db';
import { db } from '../shared/db';
import { filterAccessibleObjects, unscopedResourceIds } from '../iam';
import { actorForUser } from '../iam/actor';
import { listProjectAgents, type ProjectAgent } from './slack/selection';

/**
 * The agents a chat user may actually pick, not merely the ones the project
 * declares.
 *
 * A picker that offers an agent the presser has no access to is a dead end:
 * the pick is stored, and the next session start fails on it. Slack has run
 * its list through IAM since the picker existed; Teams offered the raw
 * declaration until 2026-09-21. Shared here so a third platform cannot repeat
 * it.
 *
 * `userId` is the Kortix user behind the chat identity, or null when the
 * person has not linked an account. An unlinked user sees the unscoped set —
 * the agents nothing restricts — which is the same answer Slack gives and
 * strictly narrower than the full declaration.
 *
 * Both filters are best effort in the same direction Slack chose: a failure
 * here leaves the list unfiltered rather than empty, because an empty picker
 * tells the user their project declares no agents, which is a lie that costs
 * more than a too-wide list the create path still rejects.
 */
export async function scopedProjectAgents(
  projectId: string,
  userId: string | null,
): Promise<ProjectAgent[]> {
  let agents: ProjectAgent[] = [];
  try {
    agents = await listProjectAgents(projectId);
  } catch (err) {
    console.warn('[channels] listProjectAgents failed', err);
  }
  if (agents.length === 0) return agents;
  try {
    const names = agents.map((a) => a.name);
    let allowed: string[];
    if (userId) {
      const [proj] = await db
        .select({ accountId: projects.accountId })
        .from(projects)
        .where(eq(projects.projectId, projectId))
        .limit(1);
      allowed = proj
        ? await filterAccessibleObjects(actorForUser(userId, proj.accountId), projectId, 'agent', names)
        : await unscopedResourceIds(projectId, 'agent', names);
    } else {
      allowed = await unscopedResourceIds(projectId, 'agent', names);
    }
    const allow = new Set(allowed);
    return agents.filter((a) => allow.has(a.name));
  } catch (err) {
    console.warn('[channels] agent scoping filter failed', err);
    return agents;
  }
}
