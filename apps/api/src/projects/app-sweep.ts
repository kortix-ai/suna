/**
 * Auto-deploy sweep for `[[apps]]` in `kortix.toml`.
 *
 * Runs on the same cadence as the trigger sweep (≈30s by default). For
 * each active project, loads the manifest, computes a stable hash of each
 * enabled app's deploy-relevant fields, and re-deploys when the hash
 * differs from the latest stored deployment (or no deployment exists yet).
 *
 * Disabling an app does NOT auto-stop deployments — explicit stop happens
 * via `POST /v1/projects/:id/apps/:slug/stop`. Keeps the sweep
 * one-directional and safe.
 */
import { and, desc, eq } from 'drizzle-orm';
import { deployments, projects } from '@kortix/db';
import { db } from '../shared/db';
import { DEFAULT_PROVIDER_NAME, getProvider } from '../deployments/providers';
import type { DeploymentRequest } from '../deployments/providers';
import {
  loadProjectApps,
  manifestHashForApp,
  resolveAppDomains,
  type AppSpec,
} from './apps';
import { resolveAppsEnabled } from './apps-config';

type ProjectRow = typeof projects.$inferSelect;
type DeploymentRow = typeof deployments.$inferSelect;

let appSweepRunning = false;

export interface AppSweepResult {
  scannedProjects: number;
  scannedApps: number;
  /** No-op because the stored hash already matches. */
  unchanged: number;
  /** Provider returned `status: 'active'`. */
  deployed: number;
  /** Provider returned `status: 'failed'` (still inserted with error). */
  failed: number;
}

/**
 * Walk every active project, load `[[apps]]`, deploy what's drifted.
 * Per-project errors are swallowed so one busted repo can't break the
 * sweep for everyone else.
 */
export async function runProjectAppSweep(): Promise<AppSweepResult> {
  // Apps is gated PER PROJECT now (metadata.apps_enabled, default
  // KORTIX_APPS_EXPERIMENTAL). We can't early-out on the global flag — a single
  // project may have opted in while the operator default is off. Each project
  // is skipped individually inside the loop below.
  if (appSweepRunning) {
    return { scannedProjects: 0, scannedApps: 0, unchanged: 0, deployed: 0, failed: 0 };
  }
  appSweepRunning = true;
  const result: AppSweepResult = {
    scannedProjects: 0,
    scannedApps: 0,
    unchanged: 0,
    deployed: 0,
    failed: 0,
  };
  try {
    const rows = await db
      .select()
      .from(projects)
      .where(eq(projects.status, 'active'))
      .limit(200);

    for (const project of rows) {
      // Skip projects that haven't opted into the experimental apps surface.
      if (!resolveAppsEnabled(project.metadata)) continue;
      result.scannedProjects += 1;
      try {
        await sweepProject(project, result);
      } catch (err) {
        console.warn('[project-apps] sweep failed for project', project.projectId, err instanceof Error ? err.message : err);
      }
    }
  } finally {
    appSweepRunning = false;
  }
  return result;
}

async function sweepProject(project: ProjectRow, result: AppSweepResult): Promise<void> {
  const { specs } = await loadProjectApps({
    projectId: project.projectId,
    repoUrl: project.repoUrl,
    defaultBranch: project.defaultBranch,
    manifestPath: project.manifestPath,
  });

  for (const spec of specs) {
    if (!spec.enabled) continue;
    result.scannedApps += 1;

    const desiredHash = manifestHashForApp(spec);
    const latest = await getLatestDeployment(project.projectId, spec.slug);
    const currentHash = (latest?.metadata as Record<string, unknown> | null)?.manifest_hash;

    if (latest && currentHash === desiredHash && latest.status === 'active') {
      result.unchanged += 1;
      continue;
    }

    const outcome = await deployAppSpec({
      project,
      spec,
      previousVersion: latest?.version ?? 0,
      manifestHash: desiredHash,
      source: 'sweep',
    });
    if (outcome === 'active') result.deployed += 1;
    else result.failed += 1;
  }
}

/**
 * Look up the latest deployment for a (project, slug). Used by the sweep
 * to detect drift and by the manual deploy path to compute the next
 * version number.
 */
export async function getLatestDeployment(
  projectId: string,
  slug: string,
): Promise<DeploymentRow | null> {
  const [row] = await db
    .select()
    .from(deployments)
    .where(and(eq(deployments.projectId, projectId), eq(deployments.appSlug, slug)))
    .orderBy(desc(deployments.createdAt))
    .limit(1);
  return row ?? null;
}

/**
 * Translate an AppSpec into the provider's DeploymentRequest shape. If
 * the spec's git source has no explicit `repo`, we fall back to the
 * project's own repo URL so the most common case (deploy this project's
 * repo) works with zero TOML boilerplate.
 */
function buildDeploymentRequest(input: {
  project: ProjectRow;
  spec: AppSpec;
}): DeploymentRequest {
  const { project, spec } = input;
  let source: DeploymentRequest['source'];
  if (spec.source.type === 'git') {
    source = {
      type: 'git',
      repo: spec.source.repo ?? project.repoUrl,
      branch: spec.source.branch ?? project.defaultBranch,
      rootPath: spec.source.rootPath ?? undefined,
    };
  } else {
    source = { type: 'tar', url: spec.source.url };
  }
  return {
    accountId: project.accountId,
    projectId: project.projectId,
    appSlug: spec.slug,
    source,
    // No declared domains → auto-issue a stable free *.style.dev URL so the
    // zero-config deploy path actually serves somewhere.
    domains: resolveAppDomains(project.projectId, spec),
    build: spec.build
      ? {
          command: spec.build.command ?? undefined,
          outDir: spec.build.outDir ?? undefined,
        }
      : undefined,
    env: Object.keys(spec.env).length > 0 ? spec.env : undefined,
  };
}

/**
 * Execute a deploy against the provider and persist a new `deployments`
 * row regardless of success. Returns the resulting status so callers can
 * report it. Shared by the sweep AND the manual `/deploy` endpoint.
 */
export async function deployAppSpec(input: {
  project: ProjectRow;
  spec: AppSpec;
  previousVersion: number;
  manifestHash: string;
  /** Where the deploy was triggered from — recorded in metadata for audit. */
  source: 'sweep' | 'manual';
}): Promise<'active' | 'failed'> {
  const { project, spec, previousVersion, manifestHash, source } = input;
  // The manifest doesn't expose a provider knob (one way to deploy);
  // the registry is internal infra so future providers can swap in
  // without touching the schema.
  const provider = getProvider(DEFAULT_PROVIDER_NAME);
  const request = buildDeploymentRequest({ project, spec });
  const result = await provider.deploy(request);

  await db.insert(deployments).values({
    accountId: project.accountId,
    projectId: project.projectId,
    appSlug: spec.slug,
    provider: provider.name,
    status: result.status === 'active' ? 'active' : 'failed',
    sourceType: request.source.type === 'git' ? 'git' : 'tar',
    sourceRef: request.source.type === 'git' ? request.source.repo : request.source.url,
    framework: spec.framework ?? null,
    domains: spec.domains,
    liveUrl: result.liveUrl,
    envVars: spec.env,
    buildConfig: spec.build ? { command: spec.build.command, out_dir: spec.build.outDir } : null,
    entrypoint: null,
    error: result.error ?? null,
    version: previousVersion + 1,
    freestyleId: result.providerId || null,
    metadata: {
      manifest_hash: manifestHash,
      app_slug: spec.slug,
      provider: provider.name,
      source,
    },
  });

  return result.status;
}
