/**
 * An App as JSON. Every response carries `capabilities` (the only thing
 * clients branch on), `uses` / `used_by` (App links, by slug) and `auth` (the
 * issuer, audience and key set URL that verify the App's Kortix sign-in tokens).
 */
import { z } from '@hono/zod-openapi';
import { appDeployments, apps } from '@kortix/db';
import { inArray } from 'drizzle-orm';
import { config } from '../config';
import { db } from '../shared/db';
import { appMonthlyEstimateUsd } from './cost';
import { appPublicUrl } from './hostnames';
import type { AppAccessMode } from './access';
import { type AppHostingType, appCapabilities } from './capabilities';
import { type AppLinkSlugs, appLinkSlugs } from './links';
import { projectIssuer } from './tokens';

type AppRow = typeof apps.$inferSelect;

/** The OpenAPI component every App response uses. */
export const AppObject = z.object({}).passthrough().openapi('KortixApp');

/** The hosting type of each App's active deployment, in one query. */
async function activeHostingTypes(rows: AppRow[]): Promise<Map<string, AppHostingType>> {
  const ids = rows.map((row) => row.activeDeploymentId).filter((id): id is string => !!id);
  if (ids.length === 0) return new Map();
  const found = await db
    .select({ deploymentId: appDeployments.deploymentId, hostingType: appDeployments.hostingType })
    .from(appDeployments)
    .where(inArray(appDeployments.deploymentId, ids));
  return new Map(found.map((row) => [row.deploymentId, row.hostingType as AppHostingType]));
}

/**
 * `viewerCanAccess` is the caller's OPEN verdict, which is not the same as the
 * verdict that put this App in their list — a project manager sees every App so
 * that a private one stays manageable, and may or may not be allowed to open
 * it. The client needs both: without this it optimistically mints an access
 * session per card and collects a 403 for every App it may only manage.
 */
function serializeApp(
  row: AppRow,
  viewerCanAccess: boolean,
  hostingType: AppHostingType | null,
  links: AppLinkSlugs,
) {
  const issuer = projectIssuer(row.projectId);
  return {
    app_id: row.appId,
    account_id: row.accountId,
    project_id: row.projectId,
    capabilities: appCapabilities(hostingType),
    slug: row.slug,
    name: row.name,
    url: appPublicUrl(row),
    access_mode: row.accessMode as AppAccessMode,
    access_revision: row.accessRevision,
    desired_state: row.desiredState,
    active_deployment_id: row.activeDeploymentId,
    machine: { cpu: row.cpuCores, memory_gb: row.memoryGb, disk_gb: row.diskGb },
    idle_timeout_seconds: row.idleTimeoutSeconds,
    /** False for a static App: it runs no machine, so there is nothing to keep on. */
    always_on: hostingType === 'static' ? false : row.alwaysOn,
    /** Verifies the Kortix sign-in tokens minted for this App (`aud` = app_id). */
    auth: { issuer, audience: row.appId, jwks_uri: `${issuer}/jwks.json` },
    uses: links.uses,
    used_by: links.usedBy,
    /** `static`: served from storage, no runtime. `sandbox`: a server App. null: never deployed. */
    hosting_type: hostingType,
    /** Ready deployments kept besides the active one (rollback targets). */
    retained_deployments: config.KORTIX_APPS_RETAINED_DEPLOYMENTS,
    /** The App's machine running 24/7 for a month at list compute rates: the monthly cost of an always-on App, the most an on-demand one can cost. A static App runs none: 0. */
    estimated_monthly_usd: hostingType === 'static' ? 0 : appMonthlyEstimateUsd(row, config.getDefaultProvider()),
    last_request_at: row.lastRequestAt?.toISOString() ?? null,
    viewer_can_access: viewerCanAccess,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

export type AppJson = ReturnType<typeof serializeApp>;

/**
 * Many Apps of one project as JSON, for `viewerId`, in two queries. `uses` / `used_by` list
 * only the linked Apps the viewer can see. `openable`: the App ids the viewer
 * may open; absent = all.
 */
export async function appsJson(rows: AppRow[], viewerId: string, openable?: Set<string>): Promise<AppJson[]> {
  const [hosting, links] = await Promise.all([
    activeHostingTypes(rows),
    appLinkSlugs(rows.map((row) => row.appId), viewerId),
  ]);
  return rows.map((row) =>
    serializeApp(
      row,
      openable ? openable.has(row.appId) : true,
      row.activeDeploymentId ? (hosting.get(row.activeDeploymentId) ?? null) : null,
      links.get(row.appId) ?? { uses: [], usedBy: [] },
    ),
  );
}

/** One App as JSON, for `viewerId`. */
export async function appJson(row: AppRow, viewerId: string): Promise<AppJson> {
  return (await appsJson([row], viewerId))[0]!;
}
