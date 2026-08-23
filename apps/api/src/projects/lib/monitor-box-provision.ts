/**
 * Monitor-box PROVISIONING — the heavy half, deliberately in its own module.
 *
 * Creating a box needs the snapshot builder, the secrets snapshot, the agent
 * grant resolver, and the API-key repository. Every one of those drags a large
 * import subtree behind it, and none of them is needed to STOP or OBSERVE a
 * box — which is what the maintenance sweep does on almost every tick. So
 * ./monitor-box.ts imports this module dynamically, only at the moment a box
 * actually has to be built. That keeps the maintenance sweep's static import
 * graph small (it was large enough to break unrelated tests that mock
 * ../projects/git) and keeps the cost off the common path.
 *
 * Spec: docs/specs/2026-08-12-monitors.md.
 */

import { randomUUID } from 'node:crypto';
import { projectMonitorBoxes, projectTriggerRuntime } from '@kortix/db';
import { and, eq, sql } from 'drizzle-orm';
import { startComputeSession } from '../../billing/services/compute-metering';
import { type ProviderName, getProvider } from '../../platform/providers';
import { sandboxFrontendBaseUrl } from '../../platform/sandbox-frontend-url';
import { createApiKey } from '../../repositories/api-keys';
import { db } from '../../shared/db';
import { DEFAULT_SANDBOX_SLUG, ensureSandboxImage, resolveTemplate } from '../../snapshots/builder';
import type { GitBackedProject } from '../git/types';
import { listProjectSecretsSnapshotForUser } from '../secrets';
import { resolveProjectAutomationActor } from '../session-lifecycle/actor';
import type { MonitorCatalogRow, MonitorProjectSnapshot } from './monitor-box-core';
import { buildMonitorEnvPayload, intersectMonitorSecretGrants } from './monitor-box-core';
import { MONITOR_PROVIDER, monitorProviderConfigured } from './monitor-box-provider';
import { isReservedSandboxEnvName } from './sandbox-env-names';
import { resolveSessionSecretGrant } from './secret-grant';
import { deriveKortixApiBase, proxyGitUrl } from './sessions';

/**
 * The monitor box's metering spec fallback. Matched to the session default for
 * the same reason the box boots the session snapshot: it IS a session-class box
 * with a different entrypoint, and the Platinum create path does not accept a
 * per-box machine size today (`resourceSpec` is ignored there). Billing must
 * describe the box that actually runs, not the one the spec table wishes for.
 */
const MONITOR_METERING_SPEC = { cpuCores: 2, memoryGb: 4, diskGb: 20, gpuCount: 0 };

function gitProjectOf(project: MonitorProjectSnapshot): GitBackedProject {
  return {
    projectId: project.projectId,
    repoUrl: project.repoUrl ?? '',
    defaultBranch: project.defaultBranch ?? 'main',
    manifestPath: project.manifestPath ?? 'kortix.yaml',
    gitAuthToken: null,
  };
}

/**
 * Provision one project's monitor box.
 *
 * The row is inserted BEFORE the provider call, guarded by the
 * `project_monitor_boxes_one_live_per_project` partial unique index: two
 * schedulers racing this leave exactly one winner, and the loser's insert
 * conflicts away without ever calling the provider. A create that then fails
 * marks the row `error`, which the next tick converts into a restart.
 */
export async function provisionMonitorBox(
  project: MonitorProjectSnapshot,
  monitors: MonitorCatalogRow[],
  revision: string,
): Promise<void> {
  if (!monitorProviderConfigured()) {
    console.warn(
      `[monitor-box] ${MONITOR_PROVIDER} is not configured; skipping monitor box for ${project.projectId}`,
    );
    return;
  }
  const userId = await resolveProjectAutomationActor(project.accountId);
  if (!userId) {
    console.warn(
      `[monitor-box] no automation actor for account ${project.accountId}; skipping ${project.projectId}`,
    );
    return;
  }

  const boxEpoch = randomUUID();
  const [row] = await db
    .insert(projectMonitorBoxes)
    .values({
      projectId: project.projectId,
      accountId: project.accountId,
      provider: MONITOR_PROVIDER,
      status: 'provisioning',
      boxEpoch,
      manifestRevision: revision,
      metadata: { monitors: monitors.map((monitor) => monitor.slug) },
    })
    .onConflictDoNothing()
    .returning({ boxId: projectMonitorBoxes.boxId });
  // Lost the one-live race. The winner is provisioning; nothing to do.
  if (!row) return;
  const boxId = row.boxId;

  try {
    const gitProject = gitProjectOf(project);
    // The sandbox token is minted against the BOX id, exactly as a session
    // token is minted against its sandbox id. The ingest route resolves the
    // token's sandbox id against `project_monitor_boxes.box_id`.
    const [sandboxKey, image] = await Promise.all([
      createApiKey({
        sandboxId: boxId,
        accountId: project.accountId,
        title: 'Monitor Box Token',
        type: 'sandbox',
      }),
      ensureSandboxImage(gitProject, {
        slug: DEFAULT_SANDBOX_SLUG,
        accountId: project.accountId,
        source: 'session-start',
        provider: MONITOR_PROVIDER,
        // A monitor box has no immutable base SHA or session branch restore
        // contract. A repository-baked image can therefore become stale before
        // this persistent box starts and stay stale for its entire lifetime.
        allowProjectImage: false,
      }),
    ]);

    const { envVars, withheldByAgent } = await buildMonitorBoxEnv({
      project,
      gitProject,
      monitors,
      boxEpoch,
      userId,
      sandboxToken: sandboxKey.secretKey,
    });
    await noteWithheldSecrets(project, withheldByAgent);

    const provider = getProvider(MONITOR_PROVIDER);
    const result = await provider.create({
      accountId: project.accountId,
      userId,
      name: `monitor-${project.projectId.slice(0, 8)}`,
      snapshot: image.snapshotName,
      workloadType: 'monitor',
      // 0 → Platinum `type: 'persistent'`. A monitor that auto-stopped on idle
      // would stop watching exactly when nothing is happening, which is the one
      // moment it must keep watching.
      autoStopInterval: 0,
      envVars,
    });

    const now = new Date();
    await db
      .update(projectMonitorBoxes)
      .set({
        externalId: result.externalId,
        status: 'running',
        startedAt: now,
        lastHeartbeatAt: now,
        updatedAt: now,
      })
      .where(eq(projectMonitorBoxes.boxId, boxId));

    await startComputeSession({
      sandboxId: boxId,
      accountId: project.accountId,
      actorUserId: userId,
      provider: MONITOR_PROVIDER,
      spec: await monitorMeteringSpec(gitProject),
      workloadType: 'monitor',
      metadata: { projectId: project.projectId, monitors: monitors.map((m) => m.slug) },
    });
    console.log(
      `[monitor-box] provisioned ${boxId} (${result.externalId}) for ${project.projectId} with ${monitors.length} monitor(s)`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db
      .update(projectMonitorBoxes)
      .set({
        status: 'error',
        updatedAt: new Date(),
        metadata: sql`coalesce(${projectMonitorBoxes.metadata}, '{}'::jsonb) || ${JSON.stringify({ lastError: message.slice(0, 2_000) })}::jsonb`,
      })
      .where(eq(projectMonitorBoxes.boxId, boxId))
      .catch(() => {});
    throw error;
  }
}

/**
 * The box's environment.
 *
 * Deliberately NOT `buildSessionRuntimeEnv`: that builder is session-shaped
 * (session id, branch name, opencode bootstrap, compiled agent config), and
 * every one of those keys is wrong here. What IS shared is the part that
 * matters — the git-proxy repo URL, the API base, and the project's runtime
 * secrets under the same grant an agent would get.
 */
async function buildMonitorBoxEnv(input: {
  project: MonitorProjectSnapshot;
  gitProject: GitBackedProject;
  monitors: MonitorCatalogRow[];
  boxEpoch: string;
  userId: string;
  sandboxToken: string;
}): Promise<{ envVars: Record<string, string>; withheldByAgent: Map<string, string[]> }> {
  const secrets = await resolveMonitorBoxSecrets(input.project, input.gitProject, input.userId);
  const envVars = {
    ...secrets.env,
    KORTIX_TOKEN: input.sandboxToken,
    KORTIX_WORKLOAD: 'monitor',
    KORTIX_MONITORS: buildMonitorEnvPayload(input.monitors),
    KORTIX_MONITOR_BOX_EPOCH: input.boxEpoch,
    KORTIX_PROJECT_ID: input.project.projectId,
    KORTIX_API_URL: deriveKortixApiBase(),
    KORTIX_FRONTEND_URL: sandboxFrontendBaseUrl(),
    KORTIX_SERVICE_PORT: '8000',
    // Clone through the Kortix Git proxy with the box's own sandbox token.
    KORTIX_REPO_URL: proxyGitUrl(input.project.projectId),
    KORTIX_DEFAULT_BRANCH: input.gitProject.defaultBranch,
    KORTIX_BASE_REF: input.gitProject.defaultBranch,
    KORTIX_PROJECT_AUTO_CLONE: '1',
    // No KORTIX_BRANCH_NAME on purpose — the daemon then leaves the checkout on
    // default-branch HEAD instead of minting a session branch.
    KORTIX_CLONE_FILTER: '',
  };
  return { envVars, withheldByAgent: secrets.withheldByAgent };
}

/**
 * Stamp `last_error` on the runtime rows of monitors whose agent grant was
 * narrowed by the shared-box intersection, so the withholding is visible in
 * `kortix triggers info` and the trigger list instead of surfacing as a
 * mystery missing-env failure inside the box. Informational only — the
 * monitor stays enabled.
 */
async function noteWithheldSecrets(
  project: MonitorProjectSnapshot,
  withheldByAgent: Map<string, string[]>,
): Promise<void> {
  if (withheldByAgent.size === 0) return;
  for (const monitor of project.monitors) {
    const agent = (monitor.spec as { agent?: unknown } | null)?.agent;
    const agentName = typeof agent === 'string' && agent.trim() ? agent.trim() : 'default';
    const withheld = withheldByAgent.get(agentName);
    if (!withheld) continue;
    const detail =
      withheld.length > 0
        ? `secrets withheld on the shared monitor box: ${withheld.join(', ')}`
        : 'unscoped secret grant narrowed to the secrets every monitor agent shares';
    const note = `${detail} — the box only carries secrets granted to EVERY enabled monitor's agent; use one agent for all monitors or align the grants`;
    await db
      .update(projectTriggerRuntime)
      .set({ lastError: note.slice(0, 2_000), updatedAt: new Date() })
      .where(
        and(
          eq(projectTriggerRuntime.projectId, project.projectId),
          eq(projectTriggerRuntime.slug, monitor.slug),
        ),
      )
      .catch(() => {});
  }
}

/**
 * The project secrets the box may hold: the INTERSECTION of the enabled
 * monitors' agent grants.
 *
 * One box runs every monitor as the same UID, so in-box process isolation does
 * not exist: any monitor process can read another's environment. A union grant
 * would therefore hand monitor A a secret only monitor B's agent is entitled
 * to (Strix HIGH on PR #6413). The enforceable rule is: a secret ships to the
 * shared box only when EVERY enabled monitor's agent is granted it. An
 * unscoped ('all') agent imposes no restriction on the others; all-unscoped
 * stays unscoped. With one distinct agent (the common case) this is exactly
 * that agent's grant, unchanged.
 *
 * Secrets a monitor's agent holds beyond the intersection are withheld — the
 * caller stamps `project_trigger_runtime.last_error` for that monitor so the
 * narrowing is visible in `kortix triggers info` instead of failing silently.
 *
 * Non-`runtime` secrets are withheld: they are delivered as a per-SESSION
 * handle, and a monitor box has no session (see resolveSecretDelivery's
 * `no_session` verdict). That is the correct fail direction — withhold, never
 * fall back to plaintext.
 */
async function resolveMonitorBoxSecrets(
  project: MonitorProjectSnapshot,
  gitProject: GitBackedProject,
  userId: string,
): Promise<{ env: Record<string, string>; withheldByAgent: Map<string, string[]> }> {
  const agentOfMonitor = (monitor: MonitorProjectSnapshot['monitors'][number]): string => {
    const agent = (monitor.spec as { agent?: unknown } | null)?.agent;
    return typeof agent === 'string' && agent.trim() ? agent.trim() : 'default';
  };
  const agents = new Set<string>(project.monitors.map(agentOfMonitor));
  const grants = new Map<string, string[] | 'all'>();
  for (const agent of agents) {
    const resolved = await resolveSessionSecretGrant({
      projectId: project.projectId,
      repoUrl: gitProject.repoUrl,
      defaultBranch: gitProject.defaultBranch,
      manifestPath: gitProject.manifestPath,
      sessionAgent: agent,
    });
    grants.set(agent, resolved === undefined || resolved === 'all' ? 'all' : resolved);
  }
  const { grant, withheldByAgent } = intersectMonitorSecretGrants(grants);

  const snapshot = await listProjectSecretsSnapshotForUser(
    project.projectId,
    userId,
    grant,
    // No session ⇒ handle-delivered secrets are withheld rather than emitted.
    null,
  );
  const env = { ...snapshot.env };
  // The same guardrail sessions get: a project secret must never clobber the
  // box's own runtime env (KORTIX_*, PATH, …).
  for (const name of Object.keys(env)) {
    if (isReservedSandboxEnvName(name)) delete env[name];
  }
  delete env.SLACK_SIGNING_SECRET;
  delete env.SLACK_BOT_TOKEN;
  return { env, withheldByAgent };
}

/** Metering spec for the box — the project's template size, or the default. */
async function monitorMeteringSpec(gitProject: GitBackedProject) {
  const spec = { ...MONITOR_METERING_SPEC };
  try {
    const template = await resolveTemplate(gitProject, DEFAULT_SANDBOX_SLUG);
    if (template.cpu !== undefined) spec.cpuCores = template.cpu;
    if (template.memoryGb !== undefined) spec.memoryGb = template.memoryGb;
    if (template.diskGb !== undefined) spec.diskGb = template.diskGb;
  } catch {
    // Repo unreachable / parse error. Metering the default is still honest
    // enough to bill; a missing meter would not be.
  }
  return spec;
}
