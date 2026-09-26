// Which agents does kortix.yaml grant one App? Split from ./routes.ts so the
// read can be tested against a real repository without the route stack.

import type { GitBackedProject } from '../projects/git/types';
import { readManifest } from '../projects/triggers';

export type AppAgentGrant = { agent_name: string; grant: 'all' | 'listed'; path: string };

/**
 * The agents whose `kortix.yaml` grant `agents.<name>.apps` names one App:
 * `apps: all`, or a list that contains the App's slug. Read-only — the
 * manifest on the default branch is the source of truth, so this route
 * reports the declaration and never writes it. It does not decide access:
 * the App gate (`./access.ts`, `./public-proxy.ts`) also requires
 * `project.app.read` in the agent's effective permissions.
 */
export function agentsGrantingApp(
  rawAgents: unknown,
  appSlug: string,
  manifestPath: string,
  origins?: Record<string, string>,
): AppAgentGrant[] {
  if (!rawAgents || typeof rawAgents !== 'object' || Array.isArray(rawAgents)) return [];
  const out: AppAgentGrant[] = [];
  for (const [name, block] of Object.entries(rawAgents as Record<string, unknown>)) {
    if (!block || typeof block !== 'object') continue;
    const grant = (block as Record<string, unknown>).apps;
    const path = `${origins?.[name] ?? manifestPath}#agents.${name}`;
    if (grant === 'all') out.push({ agent_name: name, grant: 'all', path });
    else if (Array.isArray(grant) && grant.some((slug) => typeof slug === 'string' && slug.toLowerCase() === appSlug)) {
      out.push({ agent_name: name, grant: 'listed', path });
    }
  }
  return out.sort((a, b) => a.agent_name.localeCompare(b.agent_name));
}

/**
 * Read the default branch's manifest and list the agents granting `appSlug`.
 *
 * Read-your-write: the grant is written by `PUT /agents/:agentName/scope`, the
 * CLI, or a `git push` through the Git proxy — usually on another API replica,
 * whose cache invalidation never reaches this one. A warm mirror serves the
 * default branch up to KORTIX_GIT_REFRESH_INTERVAL_MS (60 s) stale, so the App
 * Access dialog showed the grant as missing right after it was saved (release
 * gate AGP-9, v0.13.31). `forceRefresh` proves the default branch current with
 * one `ls-remote` and fetches only when it moved.
 *
 * Throws when the manifest cannot be read; the route answers 503.
 */
export async function readAgentsGrantingApp(
  project: GitBackedProject,
  appSlug: string,
): Promise<AppAgentGrant[]> {
  const manifest = await readManifest(project, { rethrowReadErrors: true, forceRefresh: true });
  if (!manifest || manifest.schemaVersion < 2) return [];
  return agentsGrantingApp(manifest.raw.agents, appSlug, manifest.path, manifest.imports?.origins.agents);
}
