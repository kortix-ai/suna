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
   * `/kortix/refresh?base=1&restart=0` after boot.
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
import { Effect } from 'effect';
import { projects, type Database } from '@kortix/db';
import { AppConfig, DatabaseService, HttpClient } from '../effect/services';
import { runEffectOrThrow } from '../effect/http';
import { getDaytonaWarm, warmSnapshotsEnabledFor } from '../shared/daytona';
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

type SandboxProviderName = 'daytona' | 'platinum';

const WPROJ_PREFIX = 'kortix-wproj-';       // daytona warm-project snapshots
const WPROJ_PREFIX_PT = 'kortix-wprojpt-';  // platinum warm-project templates
/** Either provider's warm-project name (the two prefixes are disjoint: a
 * platinum name "kortix-wprojpt-…" does NOT startWith the daytona prefix). */
const isWprojName = (n: string) => n.startsWith(WPROJ_PREFIX) || n.startsWith(WPROJ_PREFIX_PT);
/** Single-quote a value for safe embedding in a bash script. */
const sh = (v: string) => `'${String(v).replace(/'/g, `'\\''`)}'`;
const warmProjectConfig = await runEffectOrThrow(Effect.gen(function* () {
  return yield* AppConfig;
}));

const runWarmProjectDatabase = <A>(
  operation: (database: Database) => Promise<A> | A,
): Promise<A> =>
  runEffectOrThrow(Effect.gen(function* () {
    const { database } = yield* DatabaseService;
    return yield* Effect.tryPromise(async () => operation(database));
  }));

const postWarmProjectRefresh = (url: string, init: RequestInit): Promise<Response> =>
  runEffectOrThrow(Effect.gen(function* () {
    const client = yield* HttpClient;
    return yield* Effect.tryPromise(() => client.fetch(url, init));
  }));

const sleep = (ms: number): Promise<void> =>
  runEffectOrThrow(Effect.sleep(`${ms} millis`));

export interface ProjectWarmPointer {
  name: string;
  commit: string;
  baked_at: string;
  /** Which provider this warm artifact lives on. Legacy rows (no field) are
   * daytona. The session gate only consumes a pointer matching its provider. */
  provider: SandboxProviderName;
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

export function projectWarmSnapshotName(
  projectId: string,
  commitSha: string,
  warmBaseName: string,
  provider: SandboxProviderName = 'daytona',
): string {
  // Daytona's name input is left UNCHANGED (no provider in the hash, daytona
  // prefix) so existing daytona pointers compute byte-identically. Platinum gets
  // a distinct prefix + provider-salted hash so the two never collide/cross-consume.
  if (provider === 'platinum') {
    const hash = createHash('sha256').update(`${projectId}|${commitSha}|${warmBaseName}|platinum`).digest('hex').slice(0, 12);
    return `${WPROJ_PREFIX_PT}${proj8(projectId)}-${hash}`;
  }
  const hash = createHash('sha256').update(`${projectId}|${commitSha}|${warmBaseName}`).digest('hex').slice(0, 12);
  return `${WPROJ_PREFIX}${proj8(projectId)}-${hash}`;
}

/** Read the project's current warm-snapshot pointer from a metadata blob. */
export function readProjectWarmPointer(metadata: unknown): ProjectWarmPointer | null {
  const ws = (metadata as Record<string, unknown> | null | undefined)?.warm_snapshot;
  if (!ws || typeof ws !== 'object' || Array.isArray(ws)) return null;
  const raw = ws as Record<string, unknown>;
  if (typeof raw.name !== 'string' || !isWprojName(raw.name)) return null;
  return {
    name: raw.name,
    commit: typeof raw.commit === 'string' ? raw.commit : '',
    baked_at: typeof raw.baked_at === 'string' ? raw.baked_at : '',
    // Legacy rows predate the field → daytona. A platinum name implies platinum
    // even if the field is somehow absent.
    provider: raw.provider === 'platinum' || raw.name.startsWith(WPROJ_PREFIX_PT) ? 'platinum' : 'daytona',
  };
}

export async function writeProjectWarmPointer(projectId: string, ptr: ProjectWarmPointer | null): Promise<void> {
  await runWarmProjectDatabase((database) =>
    database
      .update(projects)
      .set({
        metadata: ptr
          ? sql`jsonb_set(coalesce(${projects.metadata}, '{}'::jsonb), '{warm_snapshot}', ${JSON.stringify(ptr)}::jsonb)`
          : sql`coalesce(${projects.metadata}, '{}'::jsonb) - 'warm_snapshot'`,
      })
      .where(eq(projects.projectId, projectId)),
  );
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
  opts: { onLog?: (line: string) => void; provider?: SandboxProviderName } = {},
): Promise<ProjectWarmPointer> {
  const provider: SandboxProviderName = opts.provider ?? warmProjectConfig.getDefaultProvider();
  if (!warmSnapshotsEnabledFor(provider)) throw new WarmBakeError('warm snapshots are not enabled');
  if (!project.repoUrl) throw new WarmBakeError('project has no repo url');
  if (provider === 'platinum') return bakeProjectWarmSnapshotPlatinum(project, opts);
  if (provider !== 'daytona') throw new WarmBakeError(`warm snapshots unsupported for provider ${provider}`);
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
    const ptr: ProjectWarmPointer = { name, commit: tip, baked_at: new Date().toISOString(), provider: 'daytona' };
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

  const ptr: ProjectWarmPointer = { name, commit: tip, baked_at: new Date().toISOString(), provider: 'daytona' };
  await writeProjectWarmPointer(project.projectId, ptr).catch((err) =>
    log(`[warm-project] pointer write failed: ${err instanceof Error ? err.message : String(err)}`),
  );
  await reapOldProjectWarm(project.projectId, name, log);
  return ptr;
}

/**
 * Platinum per-project warm bake. Platinum has no live-snapshot-a-builder API
 * like Daytona; instead we build a per-project STATEFUL template (via the same
 * from-build adapter the shared default uses) whose runtime == the default's,
 * and have the daemon clone the project repo during capture, driven by the
 * capture_env below. The host snapshots the VM
 * once opencode is warm + a root session is pinned, then CoW-forks it per
 * session (~1-2s, no in-box clone). Stale-tip is self-healing at the daemon
 * (git.ts re-clones when baked HEAD != session base), so this is pure upside.
 *
 * No new Platinum API: from-build already accepts capture/capture_condition/
 * capture_env. The only genuinely new behaviour is the daemon seed clone.
 */
async function bakeProjectWarmSnapshotPlatinum(
  project: WarmableProject,
  opts: { onLog?: (line: string) => void } = {},
): Promise<ProjectWarmPointer> {
  if (!project.repoUrl) throw new WarmBakeError('project has no repo url');
  const log = opts.onLog ?? ((l: string) => console.log(l));
  const { platinumProvider } = await import('./providers/platinum');
  const { proxyGitUrl } = await import('../projects/lib/sessions');
  const { resolveCommitSha } = await import('../projects/git');
  const { resolveProjectGitAuth } = await import('../projects/lib/git');
  const { resolveTemplateBySlug, computeTemplateIdentity } = await import('./templates');
  const { createApiKey } = await import('../repositories/api-keys');

  // accountId — needed to mint the short-TTL seed-clone credential. The bake is
  // called with a project subset that may omit it, so read it from the row.
  const [acct] = await runWarmProjectDatabase((database) =>
    database
      .select({ accountId: projects.accountId })
      .from(projects)
      .where(eq(projects.projectId, project.projectId))
      .limit(1),
  );
  if (!acct?.accountId) throw new WarmBakeError('project has no account');
  const accountId = acct.accountId;

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

  // Tip-keyed name (the template name itself is tip-independent, so staleness
  // would be invisible without this).
  const name = projectWarmSnapshotName(project.projectId, tip, 'platinum-default', 'platinum');

  // Idempotency: a ready warm template under this name → just (re)write pointer.
  if ((await platinumProvider.getSnapshotState(name)) === 'active') {
    const ptr: ProjectWarmPointer = { name, commit: tip, baked_at: new Date().toISOString(), provider: 'platinum' };
    await writeProjectWarmPointer(project.projectId, ptr).catch(() => {});
    return ptr;
  }

  // Mirror the DEFAULT runtime exactly (same opencode/agent/CLI a cold session
  // gets) — the repo is NOT baked via Dockerfile; it is cloned during capture.
  const template = await resolveTemplateBySlug(gitProject, 'default');
  const identity = await computeTemplateIdentity(gitProject, template);

  // Short-TTL ACCOUNT credential for the seed clone. The daemon clones the repo
  // via the Kortix git proxy using this token; the proxy accepts an account-
  // scoped (type='user') key for the project's account (a sandbox-type token
  // would require a live sandbox row, which doesn't exist during capture).
  //
  // We deliberately do NOT revoke it synchronously: buildSnapshot returns at
  // rootfs-`ready`, but the stateful CAPTURE that actually runs the seed clone
  // happens AFTER that, asynchronously, on the CP seed-baker loop. Revoking here
  // would kill the token before the clone uses it (→ seed-clone auth-fails → the
  // warm snapshot bakes WITHOUT the repo). The 30m TTL bounds exposure (the
  // capture completes within minutes), the token is overridden in every fork by
  // its own per-session token, and a capture that somehow outlives the TTL just
  // degrades to a cold snapshot (seed-baker keeps the template READY).
  const cloneCred = await createApiKey({
    accountId,
    // sandbox_id is a uuid NOT NULL column; the warm template name is NOT a uuid,
    // so binding it here fails the insert (invalid input syntax for type uuid) and
    // the whole bake throws before building. This is a type='user' (account-scoped)
    // key: authorizeGitProxy only checks accountId ownership for it, never the
    // sandbox scope, so the value is irrelevant to auth — use the projectId uuid.
    sandboxId: project.projectId,
    title: 'warm-bake seed-clone (short-TTL)',
    type: 'user',
    expiresAt: new Date(Date.now() + 30 * 60_000),
  });

  log(`[warm-project] baking platinum ${name} (project ${project.projectId.slice(0, 8)}, tip ${tip.slice(0, 8)})`);
  await platinumProvider.buildSnapshot({
    snapshotName: name,
    image: template.image ?? undefined,
    userDockerfile: identity.userDockerfile,
    entrypoint: template.entrypoint ? [template.entrypoint] : undefined,
    spec: { cpu: template.cpu, memoryGb: template.memoryGb, diskGb: template.diskGb },
    slug: 'default',
    isShared: false,
    // Per-project warm = stateful capture (CoW-forked per session). The capture
    // gates on the daemon's root-session pin file, same as the shared default,
    // so the snapshot freezes a genuinely-warm opencode + the cloned repo.
    capture: 'stateful',
    captureCondition: { cmd: 'test -f /var/run/kortix/opencode-session-id', timeoutSec: 300 },
    captureEnv: {
      // Same daemon warm-capture knobs the shared default uses.
      KORTIX_WARM_SEED: '1',
      KORTIX_ENABLE_INNER_DOCKER: '0',
      PUID: '911',
      PGID: '911',
      TZ: 'UTC',
      // Plus the repo identity so the daemon clones the project into the seed.
      KORTIX_WARM_SEED_PROJECT_CLONE: '1',
      KORTIX_PROJECT_AUTO_CLONE: '1',
      KORTIX_PROJECT_ID: project.projectId,
      KORTIX_REPO_URL: proxyGitUrl(project.projectId),
      KORTIX_DEFAULT_BRANCH: project.defaultBranch,
      KORTIX_BASE_SHA: tip,
      KORTIX_API_URL: warmProjectConfig.KORTIX_URL.replace(/\/+$/, ''),
      KORTIX_SANDBOX_TOKEN: cloneCred.secretKey,
      KORTIX_TOKEN: cloneCred.secretKey,
      // No-restart warm-fork (stateful ONLY — never cold/Daytona): bake proxy-mode
      // opencode into the seed so fork adoption hot-swaps the per-session token
      // into the live proxy instead of restarting opencode (~8s).
      KORTIX_LLM_HOTSWAP: '1',
      // Bake the FULL org catalog at PARK via the sandbox-token-authed endpoint, so
      // the picker isn't degraded to the daemon's minimal fallback. Best-effort:
      // if unreachable the daemon falls back, no boot impact.
      KORTIX_LLM_CATALOG_URL: `${warmProjectConfig.KORTIX_URL.replace(/\/+$/, '')}/v1/projects/${project.projectId}/llm-catalog`,
    },
  });

  const ptr: ProjectWarmPointer = { name, commit: tip, baked_at: new Date().toISOString(), provider: 'platinum' };
  await writeProjectWarmPointer(project.projectId, ptr).catch((err) =>
    log(`[warm-project] pointer write failed: ${err instanceof Error ? err.message : String(err)}`),
  );
  await reapOldProjectWarmPlatinum(project.projectId, name, log);
  return ptr;
}

/** Platinum equivalent of reapOldProjectWarm: delete this project's older warm
 * templates (different tip) so quota isn't burned on superseded generations. */
async function reapOldProjectWarmPlatinum(projectId: string, currentName: string, log: (l: string) => void): Promise<void> {
  try {
    const { platinumJson } = await import('../shared/platinum');
    const { platinumProvider } = await import('./providers/platinum');
    const prefix = `${WPROJ_PREFIX_PT}${proj8(projectId)}-`;
    const list = await platinumJson<Array<{ name?: string }>>('/v1/templates');
    for (const t of list) {
      if (t.name && t.name.startsWith(prefix) && t.name !== currentName) {
        await platinumProvider.deleteSnapshot(t.name);
        log(`[warm-project] reaped superseded ${t.name}`);
      }
    }
  } catch (err) {
    log(`[warm-project] platinum supersession reap skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// In-flight project bakes, deduped by projectId (a CR-merge burst must not
// stack builders).
const inflightProjectBakes = new Map<string, Promise<void>>();

/**
 * Fire-and-forget per-project bake. Safe to call from CR-merge / project-create
 * hooks and session boots — gated, deduped, never throws.
 */
export function kickProjectWarmBake(project: WarmableProject, onLog?: (l: string) => void): void {
  const provider = warmProjectConfig.getDefaultProvider();
  if (!warmSnapshotsEnabledFor(provider) || !project.repoUrl) return;
  if (usesCustomDefaultTemplate(project)) return;
  if (inflightProjectBakes.has(project.projectId)) return;
  const log = onLog ?? ((l: string) => console.log(l));
  const run = (async () => {
    try {
      await bakeProjectWarmSnapshot(project, { onLog: log, provider });
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
 * merged between bake and session. Uses the daemon endpoint
 * `/kortix/refresh?base=1&restart=0`; retried because the daemon
 * is still coming up right after a restore. Fire-and-forget by callers.
 */
export async function refreshRestoredWorkspace(externalId: string, userId: string | undefined): Promise<void> {
  const { sandboxOpencodeEndpoint } = await import('../projects/opencode-mapping');
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const ep = await sandboxOpencodeEndpoint(externalId, userId);
      if (ep) {
        const res = await postWarmProjectRefresh(`${ep.url}/kortix/refresh?base=1&restart=0`, {
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
    await sleep(3_000 * attempt);
  }
  console.warn(`[warm-project] base refresh never succeeded for ${externalId.slice(0, 8)}`);
}
