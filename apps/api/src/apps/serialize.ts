/**
 * An App as JSON, for every kind. Every response carries `kind`,
 * `capabilities` (the only thing clients branch on), `uses` / `used_by` (App
 * links, by slug), `auth` (the issuer, audience and key set URL that verify
 * the App's Kortix sign-in tokens) and `instance`: the machine state of a kind
 * that has one (`convex`), null otherwise.
 */
import { z } from '@hono/zod-openapi';
import { appDeployments, apps } from '@kortix/db';
import { inArray } from 'drizzle-orm';
import { config } from '../config';
import { db } from '../shared/db';
import { appHasBudget, appMonthlyEstimateUsd } from './budget';
import { appPublicUrl } from './hostnames';
import type { AppAccessMode } from './access';
import { type AppHostingType, appCapabilities } from './kinds';
import { convexInstanceJson } from './kinds/convex/serialize';
import { type ConvexRow, convexRowsByAppId } from './kinds/convex/provision';
import { type AppLinkSlugs, appLinkSlugs } from './links';
import { type ProjectSigner, authEnv, existingProjectSigner, projectIssuer } from './tokens';

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
  convex: ConvexRow | undefined,
  signer: ProjectSigner | null,
) {
  const issuer = projectIssuer(row.projectId);
  const instance =
    row.kind === 'convex' && convex ? convexInstanceJson(convex, signer ? authEnv(issuer, row.appId, signer) : null) : null;
  return {
    app_id: row.appId,
    account_id: row.accountId,
    project_id: row.projectId,
    kind: row.kind,
    capabilities: appCapabilities(row, hostingType),
    slug: row.slug,
    name: row.name,
    /** A web App's public URL; a `convex` App's client URL (null until it runs). */
    url: row.kind === 'convex' ? (instance?.url ?? null) : appPublicUrl(row),
    access_mode: row.accessMode as AppAccessMode,
    access_revision: row.accessRevision,
    desired_state: row.desiredState,
    active_deployment_id: row.activeDeploymentId,
    machine: { cpu: row.cpuCores, memory_gb: row.memoryGb, disk_gb: row.diskGb },
    idle_timeout_seconds: row.idleTimeoutSeconds,
    /** False for a static App: it runs no machine, so there is nothing to keep on. */
    always_on: hostingType === 'static' && row.kind !== 'convex' ? false : row.alwaysOn,
    /**
     * The monthly compute cap of an on-demand server App, which stops at it.
     * null for an always-on, static or `convex` App: its cost is fixed
     * (`estimated_monthly_usd`) or zero, and no budget stops it.
     */
    monthly_budget_usd: appHasBudget(row, hostingType) ? Number(row.monthlyBudgetUsd) : null,
    /** Verifies the Kortix sign-in tokens minted for this App (`aud` = app_id), for any kind. */
    auth: { issuer, audience: row.appId, jwks_uri: `${issuer}/jwks.json` },
    uses: links.uses,
    used_by: links.usedBy,
    /** `static`: served from storage, no runtime. `sandbox`: a server App. `convex`: its own machine. null: never deployed. */
    hosting_type: row.kind === 'convex' ? 'convex' : hostingType,
    /** Ready deployments kept besides the active one (rollback targets). */
    retained_deployments: config.KORTIX_APPS_RETAINED_DEPLOYMENTS,
    /** The App's machine running 24/7 for a month at list compute rates: the monthly cost of an always-on or `convex` App, the ceiling of an on-demand one. A static App runs none: 0. */
    estimated_monthly_usd: row.kind === 'convex'
      ? appMonthlyEstimateUsd(row, 'platinum')
      : hostingType === 'static' ? 0 : appMonthlyEstimateUsd(row, config.getDefaultProvider()),
    instance,
    last_request_at: row.lastRequestAt?.toISOString() ?? null,
    viewer_can_access: viewerCanAccess,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

export type AppJson = ReturnType<typeof serializeApp>;

/**
 * Many Apps of one project as JSON, for `viewerId`, in four queries (plus one
 * per project with a convex App, cached per replica). `uses` / `used_by` list
 * only the linked Apps the viewer can see. `openable`: the App ids the viewer
 * may open; absent = all.
 */
export async function appsJson(rows: AppRow[], viewerId: string, openable?: Set<string>): Promise<AppJson[]> {
  const convexProjects = [...new Set(rows.filter((row) => row.kind === 'convex').map((row) => row.projectId))];
  const [hosting, links, convex, signers] = await Promise.all([
    activeHostingTypes(rows),
    appLinkSlugs(rows.map((row) => row.appId), viewerId),
    convexRowsByAppId(rows.filter((row) => row.kind === 'convex').map((row) => row.appId)),
    // A convex App's instance shows the KORTIX_AUTH_* its environment holds. Read only: never creates a key.
    Promise.all(convexProjects.map(async (id) => [id, await existingProjectSigner(id)] as const)).then((pairs) => new Map(pairs)),
  ]);
  return rows.map((row) =>
    serializeApp(
      row,
      openable ? openable.has(row.appId) : true,
      row.activeDeploymentId ? (hosting.get(row.activeDeploymentId) ?? null) : null,
      links.get(row.appId) ?? { uses: [], usedBy: [] },
      convex.get(row.appId),
      signers.get(row.projectId) ?? null,
    ),
  );
}

/** One App as JSON, for `viewerId`. */
export async function appJson(row: AppRow, viewerId: string): Promise<AppJson> {
  return (await appsJson([row], viewerId))[0]!;
}
