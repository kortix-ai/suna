/**
 * An App as JSON. Every response carries `capabilities` (the only thing
 * clients branch on), its `services`, `machines`, `volumes`, `labels`, `scale`
 * and active release `config`, `uses` / `used_by` (App links, by slug) and `auth` (the
 * issuer, audience and key set URL that verify the App's Kortix sign-in tokens).
 */
import { z } from '@hono/zod-openapi';
import { appDeployments, appRuntimes, appVolumes, apps } from '@kortix/db';
import type { AppDisplay, AppReleaseConfig } from '@kortix/shared/app-config';
import { and, count, inArray, isNull, notInArray, sql, sum } from 'drizzle-orm';
import { config } from '../config';
import { db } from '../shared/db';
import { appMonthlyEstimateUsd } from './cost';
import { appPublicUrl, appServiceUrl } from './hostnames';
import { groupScale, releaseConfigOf, servingGroups } from './release-config';
import { appVmFor } from '@kortix/shared/app-config';
import type { AppAccessMode } from './access';
import { type AppHostingType, appCapabilities } from './capabilities';
import { type AppLinkSlugs, appLinkSlugs } from './links';
import { projectIssuer } from './tokens';

type AppRow = typeof apps.$inferSelect;

/** The OpenAPI component every App response uses. */
export const AppObject = z.object({}).passthrough().openapi('KortixApp');

interface ActiveRelease {
  hostingType: AppHostingType;
  config: AppReleaseConfig | null;
}

interface Fleet {
  machines: { total: number; running: number; stopped: number };
  volumes: { count: number; size_gb: number };
}

/** Each App's active release (hosting type and config), in one query. */
async function activeReleases(rows: AppRow[]): Promise<Map<string, ActiveRelease>> {
  const ids = rows.map((row) => row.activeDeploymentId).filter((id): id is string => !!id);
  if (ids.length === 0) return new Map();
  const byApp = new Map(rows.map((row) => [row.appId, row]));
  const found = await db.select().from(appDeployments).where(inArray(appDeployments.deploymentId, ids));
  return new Map(found.map((row) => {
    const hostingType = row.hostingType as AppHostingType;
    const app = byApp.get(row.appId);
    return [row.deploymentId, {
      hostingType,
      config: hostingType === 'static' || !app ? null : releaseConfigOf(row, app),
    }];
  }));
}

/** Machines and volumes per App, in two queries. */
async function fleets(rows: AppRow[]): Promise<Map<string, Fleet>> {
  const ids = rows.map((row) => row.appId);
  const out = new Map<string, Fleet>(ids.map((id) => [id, { machines: { total: 0, running: 0, stopped: 0 }, volumes: { count: 0, size_gb: 0 } }]));
  if (ids.length === 0) return out;
  const [machineRows, volumeRows] = await Promise.all([
    db.select({ appId: appDeployments.appId, status: appRuntimes.status, n: count() })
      .from(appRuntimes)
      .innerJoin(appDeployments, sql`${appDeployments.deploymentId} = ${appRuntimes.deploymentId}`)
      .where(and(inArray(appDeployments.appId, ids), notInArray(appRuntimes.status, ['deleted', 'error']), sql`${appRuntimes.processGroup} <> '_release'`))
      .groupBy(appDeployments.appId, appRuntimes.status),
    db.select({ appId: appVolumes.appId, n: count(), size: sum(appVolumes.sizeGb) })
      .from(appVolumes)
      .where(and(inArray(appVolumes.appId, ids), isNull(appVolumes.deletedAt)))
      .groupBy(appVolumes.appId),
  ]);
  for (const row of machineRows) {
    const fleet = out.get(row.appId)!;
    fleet.machines.total += Number(row.n);
    if (row.status === 'running') fleet.machines.running += Number(row.n);
    if (row.status === 'stopped') fleet.machines.stopped += Number(row.n);
  }
  for (const row of volumeRows) out.get(row.appId)!.volumes = { count: Number(row.n), size_gb: Number(row.size ?? 0) };
  return out;
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
  release: ActiveRelease | null,
  links: AppLinkSlugs,
  fleet: Fleet,
) {
  const issuer = projectIssuer(row.projectId);
  const hostingType = release?.hostingType ?? null;
  const releaseConfig = release?.config ?? null;
  const releaseVm = releaseConfig ? appVmFor(releaseConfig, servingGroups(releaseConfig)[0] ?? 'app') : null;
  return {
    app_id: row.appId,
    account_id: row.accountId,
    project_id: row.projectId,
    capabilities: appCapabilities(
      hostingType,
      fleet.volumes.count > 0 || (releaseConfig?.mounts.length ?? 0) > 0,
      row.externalUrl ? { frameable: row.externalFrameable } : null,
    ),
    slug: row.slug,
    name: row.name,
    /** The external site for an external App, else the App's Kortix host. */
    url: row.externalUrl ?? appPublicUrl(row),
    /** Set: the App is hosted elsewhere at this https URL; Kortix lists and frames it, and never deploys it. */
    external_url: row.externalUrl,
    access_mode: row.accessMode as AppAccessMode,
    access_revision: row.accessRevision,
    desired_state: row.desiredState,
    active_deployment_id: row.activeDeploymentId,
    /** The serving group's machine size in the live release (its `vm`), else the App's default size. */
    machine: releaseVm
      ? { cpu: releaseVm.cpu, memory_gb: releaseVm.memory_gb, disk_gb: releaseVm.disk_gb }
      : { cpu: row.cpuCores, memory_gb: row.memoryGb, disk_gb: row.diskGb },
    idle_timeout_seconds: row.idleTimeoutSeconds,
    /** False for a static App: it runs no machine, so there is nothing to keep on. */
    always_on: hostingType === 'static' ? false : row.alwaysOn,
    /** Verifies the Kortix sign-in tokens minted for this App (`aud` = app_id). */
    auth: { issuer, audience: row.appId, jwks_uri: `${issuer}/jwks.json` },
    uses: links.uses,
    used_by: links.usedBy,
    /** Free-form labels (e.g. `backend`); they group and filter, nothing more. */
    labels: row.labels,
    /** Where Kortix shows the App: `{ listed?, preview?: live | none, parent? }`. Presentation only. */
    display: row.display as AppDisplay,
    /** Machines per process group; a group not listed runs one. */
    scale: row.scale as Record<string, number>,
    /** The services of the active release: each with its URL (null when the host label would be too long). */
    services: (releaseConfig?.services ?? []).map((service) => ({
      name: service.name,
      protocol: service.protocol,
      access: service.access,
      internal_port: service.internal_port,
      processes: service.processes,
      url: service.protocol === 'http' ? appServiceUrl(row, service.name) : null,
    })),
    machines: fleet.machines,
    volumes: fleet.volumes,
    /** The active release's config, or null for a static App or before the first deploy. */
    config: releaseConfig,
    /** `static`: served from storage, no runtime. `sandbox`: a server App. null: never deployed. */
    hosting_type: hostingType,
    /** Ready deployments kept besides the active one (rollback targets). */
    retained_deployments: config.KORTIX_APPS_RETAINED_DEPLOYMENTS,
    /** The App's machine running 24/7 for a month at list compute rates: the monthly cost of an always-on App, the most an on-demand one can cost. A static App runs none: 0. */
    estimated_monthly_usd: hostingType === 'static' || row.externalUrl
      ? 0
      : releaseConfig
        // Every machine of every group, at its group's size, 24/7.
        ? Math.round(Object.keys(releaseConfig.processes).reduce((sum, group) => {
            const vm = appVmFor(releaseConfig, group);
            return sum + groupScale(row.scale, group) * appMonthlyEstimateUsd({ cpuCores: vm.cpu, memoryGb: vm.memory_gb, diskGb: vm.disk_gb }, config.getDefaultProvider());
          }, 0) * 100) / 100
        : appMonthlyEstimateUsd(row, config.getDefaultProvider()),
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
  const [releases, links, fleet] = await Promise.all([
    activeReleases(rows),
    appLinkSlugs(rows.map((row) => row.appId), viewerId),
    fleets(rows),
  ]);
  return rows.map((row) =>
    serializeApp(
      row,
      openable ? openable.has(row.appId) : true,
      row.activeDeploymentId ? (releases.get(row.activeDeploymentId) ?? null) : null,
      links.get(row.appId) ?? { uses: [], usedBy: [] },
      fleet.get(row.appId)!,
    ),
  );
}

/** One App as JSON, for `viewerId`. */
export async function appJson(row: AppRow, viewerId: string): Promise<AppJson> {
  return (await appsJson([row], viewerId))[0]!;
}
