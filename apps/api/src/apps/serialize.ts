/**
 * An App as JSON, for every kind. Every response carries `kind`,
 * `capabilities` (the only thing clients branch on), `uses` / `used_by` (App
 * links, by slug) and `instance`: the machine state of a kind that has one
 * (`convex`), null otherwise.
 */
import { z } from '@hono/zod-openapi';
import { appDeployments, apps } from '@kortix/db';
import { inArray } from 'drizzle-orm';
import { config } from '../config';
import { db } from '../shared/db';
import { appMonthlyEstimateUsd } from './budget';
import { appPublicUrl } from './hostnames';
import type { AppAccessMode } from './access';
import { type AppHostingType, appCapabilities } from './kinds';
import { convexInstanceJson } from './kinds/convex/serialize';
import { type ConvexRow, convexRowsByAppId } from './kinds/convex/provision';
import { type AppLinkSlugs, appLinkSlugs } from './links';

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
) {
  const instance = row.kind === 'convex' && convex ? convexInstanceJson(convex) : null;
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
    always_on: row.alwaysOn,
    monthly_budget_usd: Number(row.monthlyBudgetUsd),
    uses: links.uses,
    used_by: links.usedBy,
    /** `static`: served from storage, no runtime. `sandbox`: a server App. `convex`: its own machine. null: never deployed. */
    hosting_type: row.kind === 'convex' ? 'convex' : hostingType,
    /** Ready deployments kept besides the active one (rollback targets). */
    retained_deployments: config.KORTIX_APPS_RETAINED_DEPLOYMENTS,
    /** The App's machine running 24/7 for a month at list compute rates. A static App runs none. */
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

/** Many Apps as JSON in four queries. `openable`: the App ids the caller may open; absent = all. */
export async function appsJson(rows: AppRow[], openable?: Set<string>): Promise<AppJson[]> {
  const [hosting, links, convex] = await Promise.all([
    activeHostingTypes(rows),
    appLinkSlugs(rows.map((row) => row.appId)),
    convexRowsByAppId(rows.filter((row) => row.kind === 'convex').map((row) => row.appId)),
  ]);
  return rows.map((row) =>
    serializeApp(
      row,
      openable ? openable.has(row.appId) : true,
      row.activeDeploymentId ? (hosting.get(row.activeDeploymentId) ?? null) : null,
      links.get(row.appId) ?? { uses: [], usedBy: [] },
      convex.get(row.appId),
    ),
  );
}

/** One App as JSON. */
export async function appJson(row: AppRow): Promise<AppJson> {
  return (await appsJson([row]))[0]!;
}
