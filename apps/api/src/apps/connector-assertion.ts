/**
 * Connector → Kortix App: which connector calls carry an App assertion.
 *
 * Spec docs/specs/2026-09-22-agents-as-principals.md §2.5. The connector
 * gateway asks this module for the `X-Kortix-App-Authorization` value of an
 * agent-session call. It answers only for a base URL that is an App host of
 * THIS deployment (`resolveAppHost`) whose App belongs to the caller's OWN
 * project; every other host gets null, so a credential never leaves for a
 * foreign server. The value is a ≤ 60 s assertion (`createAppAgentAssertion`)
 * that the App gate verifies and resolves back to the session token.
 */
import { apps, projects } from '@kortix/db';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../shared/db';
import { agentPrincipalEnabled, createAppAgentAssertion } from './access';
import { appsLocalMode, resolveAppHost } from './hostnames';

export interface AppAssertionLookup {
  /** The App behind a route key, with its project's `agent_principal` flag
   *  (read through `agentPrincipalEnabled`, the same helper as the gate). */
  loadAppByRouteKey(
    routeKey: string,
  ): Promise<{ appId: string; projectId: string; agentPrincipal: boolean } | null>;
  /** Whether `*.apps.localhost` hosts are this deployment's (local dev only). */
  localMode: boolean;
}

const DEFAULT_LOOKUP: AppAssertionLookup = {
  loadAppByRouteKey: async (routeKey) => {
    const [row] = await db
      .select({ appId: apps.appId, projectId: apps.projectId, projectMetadata: projects.metadata })
      .from(apps)
      .innerJoin(projects, eq(projects.projectId, apps.projectId))
      .where(and(eq(apps.routeKey, routeKey), isNull(apps.deletedAt)))
      .limit(1);
    return row
      ? { appId: row.appId, projectId: row.projectId, agentPrincipal: agentPrincipalEnabled(row.projectMetadata) }
      : null;
  },
  get localMode() {
    return appsLocalMode();
  },
};

export async function appAuthorizationForConnectorCall(
  input: { projectId: string; baseUrl: string; sessionId: string; tokenId: string },
  lookup: AppAssertionLookup = DEFAULT_LOOKUP,
): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(input.baseUrl);
  } catch {
    return null;
  }
  const matched = resolveAppHost(url.hostname);
  if (!matched) return null;
  if (matched.local ? !lookup.localMode : url.protocol !== 'https:') return null;
  const app = await lookup.loadAppByRouteKey(matched.routeKey);
  // Same project only, and only when that (the calling) project has the
  // `agent_principal` flag on — flag OFF, the call goes out as it does today.
  if (!app || app.projectId !== input.projectId || !app.agentPrincipal) return null;
  return `Bearer ${createAppAgentAssertion({ appId: app.appId, projectId: app.projectId, tokenId: input.tokenId })}`;
}
