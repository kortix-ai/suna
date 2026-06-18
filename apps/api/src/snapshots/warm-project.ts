/**
 * Per-PROJECT warm snapshots — commit-fresh, stateful.
 *
 * The generic warm base (warm-bake.ts) only warms the RUNTIME: a session booted
 * from it still pays the git clone + opencode start, which is most of the
 * perceived latency. This module bakes a snapshot PER PROJECT with:
 *
 *   - the project repo already cloned at the default branch tip (/workspace),
 *   - opencode's caches warmed AGAINST that workspace (config parsed, project
 *     scanned, sqlite rows written),
 *
 * so a session restored from it skips the clone entirely — the daemon's
 * "using baked repo checkout" path (kortix-sandbox-agent-server/src/git.ts)
 * just creates the session branch locally — and opencode starts hot. Commits
 * that land between bake and session are covered by a fire-and-forget
 * `/kortix/refresh?base=1&restart=0` after boot (the same fast-forward the
 * warm-pool claim path uses).
 *
 * Names are content-addressed per (project, tip commit, warm runtime base):
 * `kortix-wproj-<proj8>-<hash12>`. A CR merge bakes a new name; the project's
 * previous snapshots are reaped immediately on success (per-project snapshots
 * belong to exactly one environment's DB, so supersession is safe). The
 * current pointer lives in `projects.metadata.warm_snapshot` so the session
 * hot path never lists the org.
 *
 * Scope: default-template projects only (the warm gate in session-sandbox.ts
 * already restricts warm boots to the platform default slug). Same kill
 * switches as the base path: warmSnapshotsEnabled().
 */

import { createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { projects } from '@kortix/db';
import { db } from '../shared/db';
import { getDaytonaWarm, warmSnapshotsEnabled } from '../shared/daytona';
import {
  createHealthyBuilder,
  OPENCODE_PORT,
  SNAPSHOT_TIMEOUT_S,
  step,
  WarmBakeError,
  warmBaseSnapshotName,
  warmBaseUsable,
  XDG_EXPORTS,
} from './warm-bake';
import type { GitBackedProject } from '../projects/git';

const WPROJ_PREFIX = 'kortix-wproj-';
/** Single-quote a value for safe embedding in a bash script. */
const sh = (v: string) => `'${String(v).replace(/'/g, `'\\''`)}'`;

export interface ProjectWarmPointer {
  name: string;
  commit: string;
  baked_at: string;
}

/** Minimal project shape the baker needs (subset of the projects row). */
export interface WarmableProject {
  projectId: string;
  repoUrl: string | null;
  defaultBranch: string;
  manifestPath: string | null;
  /** Optional projects.metadata — used to skip projects whose default template
   * is custom (their sessions can't use the default-runtime warm snapshot). */
  metadata?: unknown;
}

/** True when the project's default template is a custom slug — its sessions
 * boot that template's image, so a default-runtime warm snapshot would only
 * burn a quota slot without ever being used. */
function usesCustomDefaultTemplate(project: WarmableProject): boolean {
  const meta = (project.metadata ?? null) as Record<string, unknown> | null;
  const slug = typeof meta?.default_sandbox_slug === 'string' ? meta.default_sandbox_slug.trim() : '';
  return !!slug && slug !== 'default';
}

function proj8(projectId: string): string {
  return projectId.replace(/-/g, '').slice(0, 8);
}

export function projectWarmSnapshotName(projectId: string, commitSha: string, warmBaseName: string): string {
  const hash = createHash('sha256').update(`${projectId}|${commitSha}|${warmBaseName}`).digest('hex').slice(0, 12);
  return `${WPROJ_PREFIX}${proj8(projectId)}-${hash}`;
}

/** Read the project's current warm-snapshot pointer from a metadata blob. */
export function readProjectWarmPointer(metadata: unknown): ProjectWarmPointer | null {
  const ws = (metadata as Record<string, unknown> | null | undefined)?.warm_snapshot;
  if (!ws || typeof ws !== 'object' || Array.isArray(ws)) return null;
  const raw = ws as Record<string, unknown>;
  if (typeof raw.name !== 'string' || !raw.name.startsWith(WPROJ_PREFIX)) return null;
  return {
    name: raw.name,
    commit: typeof raw.commit === 'string' ? raw.commit : '',
    baked_at: typeof raw.baked_at === 'string' ? raw.baked_at : '',
  };
}

export async function writeProjectWarmPointer(projectId: string, ptr: ProjectWarmPointer | null): Promise<void> {
  await db
    .update(projects)
    .set({
      metadata: ptr
        ? sql`jsonb_set(coalesce(${projects.metadata}, '{}'::jsonb), '{warm_snapshot}', ${JSON.stringify(ptr)}::jsonb)`
        : sql`coalesce(${projects.metadata}, '{}'::jsonb) - 'warm_snapshot'`,
    })
    .where(eq(projects.projectId, projectId));
}

/** Delete this project's other warm snapshots (older identities). Project
 * snapshots belong to one environment's DB, so immediate supersession is safe
 * — a box already restored from an old one is unaffected by the delete. */
async function reapOldProjectWarm(projectId: string, currentName: string, log: (l: string) => void): Promise<void> {
  try {
    const { listDaytonaSnapshots, deleteDaytonaSnapshotById } = await import('../shared/daytona');
    const prefix = `${WPROJ_PREFIX}${proj8(projectId)}-`;
    const stale = (await listDaytonaSnapshots()).filter((s) => s.name.startsWith(prefix) && s.name !== currentName);
    for (const snap of stale) {
      const ok = await deleteDaytonaSnapshotById(snap.id);
      log(`[warm-project] reaped superseded ${snap.name}: ${ok ? 'ok' : 'failed'}`);
    }
  } catch (err) {
    log(`[warm-project] supersession reap skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Bake the project's warm snapshot at the current default-branch tip.
 * Idempotent: a usable snapshot under the computed name short-circuits (and
 * just refreshes the pointer). Requires the generic warm base to exist — it is
 * the builder seed (region-local, full runtime, platform spec).
 */
export async function bakeProjectWarmSnapshot(
  project: WarmableProject,
  opts: { onLog?: (line: string) => void } = {},
): Promise<ProjectWarmPointer> {
  if (!warmSnapshotsEnabled()) throw new WarmBakeError('warm snapshots are not enabled');
  if (!project.repoUrl) throw new WarmBakeError('project has no repo url');
  const log = opts.onLog ?? ((l: string) => console.log(l));
  const daytona = getDaytonaWarm();

  // Builder seed: the current runtime warm base. Missing → kick its bake and
  // bail; the project bake re-runs on the next trigger.
  const baseName = await warmBaseSnapshotName();
  const baseSnap = await daytona.snapshot.get(baseName).catch(() => null);
  if (!warmBaseUsable(baseSnap)) {
    const { kickWarmBaseBuild } = await import('./warm-bake');
    kickWarmBaseBuild(log);
    throw new WarmBakeError(`warm base ${baseName} not ready — project bake deferred`);
  }

  // Tip of the default branch (what the snapshot will contain).
  const { resolveCommitSha } = await import('../projects/git');
  const { resolveProjectGitAuth } = await import('../projects/lib/git');
  const gitAuth = await resolveProjectGitAuth(project as never).catch(() => null);
  const gitProject: GitBackedProject = {
    projectId: project.projectId,
    repoUrl: project.repoUrl,
    defaultBranch: project.defaultBranch,
    manifestPath: project.manifestPath ?? '',
    gitAuthToken: gitAuth?.auth?.token ?? null,
  };
  const tip = await resolveCommitSha(gitProject, project.defaultBranch);
  if (!tip) throw new WarmBakeError(`could not resolve ${project.defaultBranch} tip`);

  const name = projectWarmSnapshotName(project.projectId, tip, baseName);
  const existing = await daytona.snapshot.get(name).catch(() => null);
  if (warmBaseUsable(existing)) {
    const ptr: ProjectWarmPointer = { name, commit: tip, baked_at: new Date().toISOString() };
    await writeProjectWarmPointer(project.projectId, ptr).catch(() => {});
    return ptr;
  }

  // One-shot upstream credentials for the clone. The auth header is passed via
  // `git -c http.extraHeader` (never written to git config) inside a script
  // file that is deleted in the same invocation — nothing credential-shaped
  // survives into the snapshot. The baked origin is the Kortix git proxy; the
  // daemon's credential helper auths it per-session.
  const { resolveProjectUpstream } = await import('../projects/lib/git');
  const upstream = await resolveProjectUpstream(project as never, 'read');
  if (!upstream?.url) throw new WarmBakeError('no git upstream configured for project');
  const headerFlags = Object.entries(upstream.headers ?? {})
    .map(([k, v]) => `-c http.extraHeader=${sh(`${k}: ${v}`)}`)
    .join(' ');
  const { proxyGitUrl } = await import('../projects/lib/sessions');
  const originUrl = proxyGitUrl(project.projectId);

  log(`[warm-project] baking ${name} (project ${project.projectId.slice(0, 8)}, tip ${tip.slice(0, 8)}) from ${baseName}`);
  const sb = await createHealthyBuilder(baseName, log);
  try {
    await step(
      sb,
      'clone workspace at tip',
      `set -e
sudo rm -rf /workspace && sudo mkdir -p /workspace
sudo git ${headerFlags} clone --branch ${sh(project.defaultBranch)} ${sh(upstream.url)} /workspace >/tmp/clone.log 2>&1
sudo git -C /workspace remote set-url origin ${sh(originUrl)}
sudo rm -f /tmp/clone.log /tmp/_kortix_bake.sh
echo "HEAD=$(sudo git -C /workspace rev-parse HEAD)"`,
      300,
      log,
    );

    // Warm opencode against THIS workspace: parses config, scans the project,
    // writes its sqlite rows — all baked into the snapshot's disk + caches. The
    // server is killed before snapshotting (the session daemon spawns its own
    // with real per-session env).
    await step(
      sb,
      'opencode workspace prewarm',
      `${XDG_EXPORTS}
sudo -E bash -c '${XDG_EXPORTS}
cd /workspace
opencode serve --port ${OPENCODE_PORT} --hostname 127.0.0.1 >/tmp/oc-prewarm.log 2>&1 &
pid=$!
for i in $(seq 1 60); do curl -s -o /dev/null -m 2 http://127.0.0.1:${OPENCODE_PORT}/ && break; sleep 1; done
sleep 3
kill $pid 2>/dev/null; sleep 1
tail -2 /tmp/oc-prewarm.log; rm -f /tmp/oc-prewarm.log'`,
      180,
      log,
    );

    const snapStart = Date.now();
    await sb._experimental_createSnapshot(name, SNAPSHOT_TIMEOUT_S);
    log(`[warm-project] ${name} snapshotted in ${((Date.now() - snapStart) / 1000).toFixed(1)}s`);
  } finally {
    await sb.delete().catch(() => {});
  }

  const ptr: ProjectWarmPointer = { name, commit: tip, baked_at: new Date().toISOString() };
  await writeProjectWarmPointer(project.projectId, ptr).catch((err) =>
    log(`[warm-project] pointer write failed: ${err instanceof Error ? err.message : String(err)}`),
  );
  await reapOldProjectWarm(project.projectId, name, log);
  return ptr;
}

// In-flight project bakes, deduped by projectId (a CR-merge burst must not
// stack builders).
const inflightProjectBakes = new Map<string, Promise<void>>();

/**
 * Fire-and-forget per-project bake. Safe to call from CR-merge / project-create
 * hooks and session boots — gated, deduped, never throws.
 */
export function kickProjectWarmBake(project: WarmableProject, onLog?: (l: string) => void): void {
  if (!warmSnapshotsEnabled() || !project.repoUrl) return;
  if (usesCustomDefaultTemplate(project)) return;
  if (inflightProjectBakes.has(project.projectId)) return;
  const log = onLog ?? ((l: string) => console.log(l));
  const run = (async () => {
    try {
      await bakeProjectWarmSnapshot(project, { onLog: log });
    } catch (err) {
      log(`[warm-project] bake failed for ${project.projectId.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      inflightProjectBakes.delete(project.projectId);
    }
  })();
  inflightProjectBakes.set(project.projectId, run);
}

/**
 * Fast-forward a restored workspace to the CURRENT base tip — covers commits
 * merged between bake and session. Same daemon endpoint the warm-pool claim
 * path uses (`/kortix/refresh?base=1&restart=0`); retried because the daemon
 * is still coming up right after a restore. Fire-and-forget by callers.
 */
export async function refreshRestoredWorkspace(externalId: string, userId: string | undefined): Promise<void> {
  const { sandboxOpencodeEndpoint } = await import('../projects/opencode-mapping');
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const ep = await sandboxOpencodeEndpoint(externalId, userId);
      if (ep) {
        const res = await fetch(`${ep.url}/kortix/refresh?base=1&restart=0`, {
          method: 'POST',
          headers: ep.headers,
          signal: AbortSignal.timeout(25_000),
        });
        if (res.ok) return;
        // 409 = a refresh is already running — good enough.
        if (res.status === 409) return;
      }
    } catch {
      /* daemon not up yet — retry */
    }
    await new Promise((r) => setTimeout(r, 3_000 * attempt));
  }
  console.warn(`[warm-project] base refresh never succeeded for ${externalId.slice(0, 8)}`);
}
