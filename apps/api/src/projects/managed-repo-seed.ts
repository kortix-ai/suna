/**
 * Managed-repo scaffold seed: verification, state recording, and self-heal.
 *
 * A brand-new managed project is only usable once its repo carries a real
 * commit on the default branch — the agents, skills, `kortix.yaml`, and every
 * OpenCode/Claude/Codex/Pi runtime profile live IN the repo, and session start
 * pushes a session branch off `refs/heads/<default_branch>`. A repo with no
 * default branch is therefore structurally dead: the file browser is empty, no
 * agent resolves, manifest detection falls back to v1, and session start dies
 * with `fatal: couldn't find remote ref refs/heads/main`
 * (`createRemoteSessionBranch`, ./git/branches.ts).
 *
 * `POST /projects/provision` used to report `201 { status: 'active' }` for
 * exactly that repo whenever the caller did not pass `seed_starter: true`, and
 * nothing anywhere recorded whether a seed had been expected. This module
 * closes both halves:
 *
 *  1. `pushVerifiedSeed` — a seed is not "done" because the backend call
 *     resolved. It is done when `refs/heads/<branch>` is observably present on
 *     the remote. Anything else is a loud, project-id-tagged failure, bounded
 *     by one retry.
 *  2. `buildManagedRepoSeedState` / `readManagedRepoSeedState` /
 *     `shouldSelfHealManagedRepoSeed` — the seed intent AND outcome live on
 *     `project.metadata.git.seed`, so "empty because the caller asked for an
 *     empty repo" is distinguishable from "empty because the seed never
 *     landed", and the second case can be repaired on next access.
 *
 * `expected: false` is a first-class, permanently-respected state: `kortix ship`
 * (apps/cli/src/commands/ship.ts) provisions with no `seed_starter` and then
 * pushes its own local history to the default branch with a plain (non-force)
 * push. Seeding that repo — at provision time or later — would turn that push
 * into a non-fast-forward rejection. So the fix is never "always seed"; it is
 * "always know, and repair only what was supposed to be seeded".
 */

import type { GitConnectionRef, GitHostBackend, SeedFile } from './git-backends/types';

/** Recorded on `project.metadata.git.seed`. */
export interface ManagedRepoSeedState {
  /** The default branch was verified present on the remote. */
  seeded: boolean;
  /** The provisioning caller asked for a scaffold seed. */
  expected: boolean;
  /** Why the repo is in this state — surfaced in logs and repair decisions. */
  reason: ManagedRepoSeedReason;
  /** ISO timestamp of the last transition. */
  at: string;
  /** Starter template the seed used, so a later repair reproduces it faithfully. */
  template?: string;
}

export type ManagedRepoSeedReason =
  | 'seeded'
  | 'pending'
  | 'caller_opted_out'
  | 'push_failed'
  | 'verify_failed'
  | 'self_healed';

export type ManagedRepoSeedStage = 'push' | 'verify';

/** A seed that did not verifiably produce the default branch. Never swallowed. */
export class ManagedRepoSeedError extends Error {
  readonly projectId: string;
  readonly stage: ManagedRepoSeedStage;
  readonly branch: string;

  constructor(input: {
    projectId: string;
    stage: ManagedRepoSeedStage;
    branch: string;
    detail: string;
    cause?: unknown;
  }) {
    super(
      `managed repo seed ${input.stage} failed for project ${input.projectId} ` +
        `(default branch "${input.branch}"): ${input.detail}`,
      input.cause === undefined ? undefined : { cause: input.cause },
    );
    this.name = 'ManagedRepoSeedError';
    this.projectId = input.projectId;
    this.stage = input.stage;
    this.branch = input.branch;
  }
}

/**
 * Total pushes attempted by `pushVerifiedSeed`. A bounded retry covers the two
 * transient shapes we have actually seen — a 5xx from the hosting backend, and
 * a ref that has not appeared yet — without ever looping. Re-pushing is safe
 * because a retry only happens while the branch is still ABSENT, so there is no
 * tip to fast-forward from and no double commit to create.
 */
const MAX_SEED_ATTEMPTS = 2;

/**
 * Push the scaffold, then PROVE the default branch exists. Resolves only when
 * the remote observably carries `refs/heads/<branch>`.
 *
 * `push` and `remoteHasBranch` are injected so the transport (code.storage
 * commit-pack, a `git push` from a temp clone, `git ls-remote`) stays with its
 * owner and this control flow stays unit-testable.
 *
 * Fails CLOSED: if the verification check itself cannot answer, the seed is
 * reported as unverified. Reporting a project active on an unproven repo is the
 * exact defect this replaces.
 */
export async function pushVerifiedSeed(input: {
  projectId: string;
  branch: string;
  push: () => Promise<void>;
  remoteHasBranch: () => Promise<boolean>;
  maxAttempts?: number;
}): Promise<void> {
  const maxAttempts = Math.max(1, input.maxAttempts ?? MAX_SEED_ATTEMPTS);
  let lastDetail = 'the default branch was still absent after the seed push';
  let lastStage: ManagedRepoSeedStage = 'verify';
  let lastCause: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await input.push();
    } catch (error) {
      lastStage = 'push';
      lastCause = error;
      lastDetail = error instanceof Error ? error.message : String(error);
      continue;
    }
    try {
      if (await input.remoteHasBranch()) return;
      lastStage = 'verify';
      lastCause = undefined;
      lastDetail = 'the default branch was still absent after the seed push';
    } catch (error) {
      lastStage = 'verify';
      lastCause = error;
      lastDetail = `could not verify the default branch: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
  }

  const failure = new ManagedRepoSeedError({
    projectId: input.projectId,
    stage: lastStage,
    branch: input.branch,
    detail: lastDetail,
    cause: lastCause,
  });
  console.error(
    `[managed-repo-seed] project=${input.projectId} branch=${input.branch} ` +
      `stage=${lastStage} attempts=${maxAttempts}: ${lastDetail}`,
  );
  throw failure;
}

export function buildManagedRepoSeedState(input: {
  seeded: boolean;
  expected: boolean;
  reason: ManagedRepoSeedReason;
  at: string;
  template?: string;
}): ManagedRepoSeedState {
  return {
    seeded: input.seeded,
    expected: input.expected,
    reason: input.reason,
    at: input.at,
    ...(input.template ? { template: input.template } : {}),
  };
}

/** Read `metadata.git.seed`. Null for a project provisioned before this existed. */
export function readManagedRepoSeedState(metadata: unknown): ManagedRepoSeedState | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const git = (metadata as { git?: unknown }).git;
  if (!git || typeof git !== 'object') return null;
  const seed = (git as { seed?: unknown }).seed;
  if (!seed || typeof seed !== 'object') return null;
  const raw = seed as Record<string, unknown>;
  if (typeof raw.seeded !== 'boolean' || typeof raw.expected !== 'boolean') return null;
  return {
    seeded: raw.seeded,
    expected: raw.expected,
    reason: (typeof raw.reason === 'string' ? raw.reason : 'pending') as ManagedRepoSeedReason,
    at: typeof raw.at === 'string' ? raw.at : '',
    ...(typeof raw.template === 'string' ? { template: raw.template } : {}),
  };
}

/**
 * May Kortix seed this project's repo on demand?
 *
 * Yes for a MANAGED repo whose seed was expected but never verified, and for a
 * managed repo with no recorded state at all — every project created before
 * this module existed, including the ones already broken in production. Those
 * repos are dead today; seeding them is the only path back.
 *
 * No for `expected: false` — the `kortix ship` contract owns that repo's first
 * commit (see the module docstring). No for a repo Kortix does not manage.
 */
export function shouldSelfHealManagedRepoSeed(input: {
  managed: boolean;
  metadata: unknown;
}): boolean {
  if (!input.managed) return false;
  const state = readManagedRepoSeedState(input.metadata);
  if (!state) return true;
  if (state.seeded) return false;
  return state.expected;
}

/**
 * Is this git failure "the default branch does not exist on the remote"?
 *
 * The two wordings a structurally empty managed repo produces, in order, from
 * `createRemoteSessionBranch` (./git/branches.ts): the shallow fetch prints
 * `couldn't find remote ref refs/heads/<branch>`, and a `rev-parse --verify`
 * of the same ref prints `Needed a single revision`.
 *
 * Deliberately narrow. An auth failure, a timeout, or an unknown-pathspec error
 * must NOT be mistaken for a missing branch — that would turn a transient
 * outage into a repair push against a repo that already has history.
 */
export function isMissingRemoteBranchError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const err = error as { message?: unknown; stderr?: unknown };
  const text = [
    typeof err.message === 'string' ? err.message : '',
    typeof err.stderr === 'string' ? err.stderr : '',
  ].join('\n');
  if (!text) return false;
  return text.includes("couldn't find remote ref") || text.includes('Needed a single revision');
}

/**
 * The one place that turns a set of seed files into commits on the remote,
 * shared by provisioning and the self-heal path. Prefers the backend's native
 * seam (code.storage's commit-pack) and falls back to a real `git push` from a
 * throwaway clone for any plain HTTPS remote.
 */
export async function pushSeedFiles(input: {
  backend: GitHostBackend;
  connRef: GitConnectionRef;
  token: string;
  branch: string;
  files: SeedFile[];
  baseFiles: SeedFile[];
}): Promise<void> {
  if (input.backend.seedFiles) {
    await input.backend.seedFiles(input.connRef, input.token, input.files, {
      branch: input.branch,
      message: 'chore: scaffold Kortix project',
      baseFiles: input.baseFiles,
    });
    return;
  }
  const { seedRepoViaGitPush } = await import('./git-backends/seed');
  await seedRepoViaGitPush({
    upstreamUrl: input.connRef.upstreamUrl,
    token: input.token,
    files: input.files,
    branch: input.branch,
    commitMessage: 'chore: scaffold Kortix project',
    baseFiles: input.baseFiles,
  });
}

export type SelfHealOutcome = { repaired: true } | { repaired: false; skipped: SelfHealSkipReason };

export type SelfHealSkipReason =
  | 'project_missing'
  | 'not_managed'
  | 'caller_owns_first_commit'
  | 'already_seeded'
  | 'no_backend'
  | 'no_credential'
  | 'seed_failed';

/**
 * One in-flight repair per project. Two concurrent session creates on the same
 * empty repo would otherwise both push a scaffold; the loser's push would then
 * either race the winner's or double-commit. Mirrors `refreshLocks` in
 * ./git/mirror.ts.
 */
const repairLocks = new Map<string, Promise<SelfHealOutcome>>();

/**
 * Seed a managed repo that is missing its default branch, on demand.
 *
 * Every project created before `metadata.git.seed` existed — including the ones
 * already broken in production — has no marker, and a managed repo with no
 * default branch cannot do anything at all. Repairing it on first access is the
 * only path back that does not need a migration or a backfill job.
 *
 * Idempotent and bounded: re-verifies the remote first (so a healthy repo costs
 * one `ls-remote` and nothing else), takes a per-project lock, pushes at most
 * `MAX_SEED_ATTEMPTS` times through `pushVerifiedSeed`, and NEVER throws — the
 * caller's original error is the one the user should see if the repair cannot
 * help.
 */
export function ensureManagedRepoSeeded(
  projectId: string,
  trigger: string,
): Promise<SelfHealOutcome> {
  const inFlight = repairLocks.get(projectId);
  if (inFlight) return inFlight;
  const run = repairManagedRepo(projectId, trigger).finally(() => {
    repairLocks.delete(projectId);
  });
  repairLocks.set(projectId, run);
  return run;
}

async function repairManagedRepo(projectId: string, trigger: string): Promise<SelfHealOutcome> {
  try {
    const { projects } = await import('@kortix/db');
    const { eq } = await import('drizzle-orm');
    const { db } = await import('../shared/db');
    const [row] = await db
      .select()
      .from(projects)
      .where(eq(projects.projectId, projectId))
      .limit(1);
    if (!row) return { repaired: false, skipped: 'project_missing' };

    const { buildConnectionRef, getProjectGitConnection, getProjectGitRemote, withProjectGitAuth } =
      await import('./lib/git');
    const remote = getProjectGitRemote(row, await getProjectGitConnection(projectId));
    if (!remote.managed) return { repaired: false, skipped: 'not_managed' };
    if (!shouldSelfHealManagedRepoSeed({ managed: true, metadata: row.metadata })) {
      return { repaired: false, skipped: 'caller_owns_first_commit' };
    }

    const access = await withProjectGitAuth(row);
    const { invalidateProjectMirror, remoteBranchExists } = await import('./git');
    const gitProject = {
      projectId,
      repoUrl: access.repoUrl,
      defaultBranch: row.defaultBranch,
      manifestPath: row.manifestPath,
      gitAuthToken: access.gitAuthToken,
      gitAuthHeaders: access.gitAuthHeaders,
    };
    if (await remoteBranchExists(gitProject, row.defaultBranch)) {
      return { repaired: false, skipped: 'already_seeded' };
    }

    const { getBackend, hasBackend } = await import('./git-backends');
    if (!hasBackend(remote.provider)) return { repaired: false, skipped: 'no_backend' };
    const backend = getBackend(remote.provider);
    const connRef = buildConnectionRef(row, remote);
    const token = access.gitAuthToken;
    if (!token) return { repaired: false, skipped: 'no_credential' };

    // Reproduce what provisioning would have pushed. `metadata.git.seed.template`
    // records it exactly; a project created by a `registry:project` clone stores
    // the marketplace item id there, so the repair rebuilds THAT and not the
    // plain starter. Rows with no marker predate the recording and get the
    // default starter — the same thing the web create flow asks for.
    const recorded = readManagedRepoSeedState(row.metadata);
    const { STARTER_TEMPLATE_IDS } = await import('@kortix/starter');
    const { normalizeStarterTemplateId } = await import('./starter');
    const recordedTemplate = recorded?.template;
    const sourceItemId =
      recordedTemplate && !(STARTER_TEMPLATE_IDS as readonly string[]).includes(recordedTemplate)
        ? recordedTemplate
        : null;
    const template = normalizeStarterTemplateId(recordedTemplate);
    const repoFullName = remote.repoName ?? row.name;
    const { buildProjectSeedFiles, buildProjectSeedFilesFromItem, defaultAgentFromSeedFiles } =
      await import('./seed-files');
    const seed = sourceItemId
      ? await buildProjectSeedFilesFromItem({
          id: sourceItemId,
          projectName: row.name,
          repoFullName,
          extraMarketplaceItems: [],
          now: new Date().toISOString(),
        })
      : await buildProjectSeedFiles({
          projectName: row.name,
          repoFullName,
          template,
          marketplaceItems: [],
          now: new Date().toISOString(),
        });

    console.warn(
      `[managed-repo-seed] repairing empty managed repo project=${projectId} ` +
        `provider=${remote.provider} branch=${row.defaultBranch} ` +
        `source=${sourceItemId ?? template} trigger=${trigger}`,
    );
    await pushVerifiedSeed({
      projectId,
      branch: row.defaultBranch,
      push: () =>
        pushSeedFiles({
          backend,
          connRef,
          token,
          branch: row.defaultBranch,
          files: seed.files,
          baseFiles: seed.baseFiles,
        }),
      remoteHasBranch: () => remoteBranchExists(gitProject, row.defaultBranch),
    });

    const { metadataMerge } = await import('./lib/metadata-merge');
    const defaultAgent = defaultAgentFromSeedFiles(seed.files, row.manifestPath);
    await db
      .update(projects)
      .set({
        metadata: metadataMerge({
          ...(defaultAgent ? { default_agent: defaultAgent } : {}),
          git: {
            seed: buildManagedRepoSeedState({
              seeded: true,
              expected: true,
              reason: 'self_healed',
              at: new Date().toISOString(),
              template: sourceItemId ?? template,
            }),
          },
        }),
        updatedAt: new Date(),
      })
      .where(eq(projects.projectId, projectId))
      .catch(() => {});
    invalidateProjectMirror(projectId);
    console.warn(`[managed-repo-seed] repaired empty managed repo project=${projectId}`);
    return { repaired: true };
  } catch (error) {
    console.error(
      `[managed-repo-seed] repair failed project=${projectId} trigger=${trigger}:`,
      error instanceof Error ? error.message : error,
    );
    return { repaired: false, skipped: 'seed_failed' };
  }
}
