/**
 * The desired release for one session: one definition, shared by the
 * descriptor route (the daemon's request) and `GET /config` (the web, CLI,
 * and SDK read). Spec: docs/specs/config-releases.md, "Release builder" and
 * "Quarantine across the project".
 *
 * The desired release is ALWAYS the base branch's current tip. There is no
 * per-session mode: a session that edited its config dir under `/workspace`
 * still receives the base release, and its edits reach the box only once they
 * are pushed to the base branch. The one exception is the project quarantine,
 * which assigns the last release a session proved when the tip's release has
 * failed in enough sessions — a bad base config must not make sessions
 * unbootable.
 */

import { resolveCommitSha } from '../projects/git/commits';
import { invalidateProjectMirror } from '../projects/git/mirror';
import type { GitBackedProject } from '../projects/git/types';
import { repositoryAccessFromSessionMetadata } from '../projects/lib/session-sandbox-metadata';
import {
  buildConfigRelease,
  toDescriptor,
  type ConfigReleaseDescriptor,
  type ConfigReleaseVariant,
} from './builder';
import { dbConfigReleaseLedger, PROJECT_QUARANTINE_SESSIONS, type ConfigReleaseLedger } from './quarantine';

/** Variant selection. Identical to `pushSessionAgentConfigToSandbox`. */
export function configReleaseVariant(session: { metadata: unknown; agentName: string | null }): ConfigReleaseVariant {
  return !repositoryAccessFromSessionMetadata(session.metadata) && session.agentName
    ? `agent:${session.agentName}`
    : 'project';
}

export class BaseRefUnresolvedError extends Error {
  constructor(readonly baseRef: string, cause: Error) {
    super(`base ref ${baseRef} does not resolve: ${cause.message}`);
    this.name = 'BaseRefUnresolvedError';
  }
}

export interface DesiredReleaseInput {
  project: GitBackedProject;
  baseRef: string;
  variant: ConfigReleaseVariant;
  /** The descriptor carries an archive only with repository access. */
  repositoryAccess: boolean;
  /** Record the assignment. Only the daemon's own request records it. */
  recordAssignment?: boolean;
}

export interface DesiredRelease {
  baseSha: string;
  descriptor: ConfigReleaseDescriptor;
  /** The base release ID the project quarantined, when a fallback replaced it. */
  quarantinedReleaseId: string | null;
}

export interface DesiredReleaseDeps {
  ledger: ConfigReleaseLedger;
  build: typeof buildConfigRelease;
  resolveBase: (project: GitBackedProject, ref: string) => Promise<string>;
}

const defaultDeps: DesiredReleaseDeps = {
  ledger: dbConfigReleaseLedger,
  build: (project, commit, variant, options) => buildConfigRelease(project, commit, variant, options),
  resolveBase: resolveCommitSha,
};

/**
 * The ledger's variant key. A session without repository access runs a
 * different release ID (governance only) than one with access, so the two
 * never share a fallback.
 */
export function ledgerVariant(variant: ConfigReleaseVariant, repositoryAccess: boolean): string {
  return repositoryAccess ? variant : `${variant}#governance-only`;
}

/**
 * Resolve the base tip, build its release, and apply the project quarantine. A quarantined release is replaced by the newest release
 * of the same variant that any session proved; with none, the quarantined
 * release is assigned unchanged and each box keeps its own last proven
 * config through its box quarantine and fallback chain.
 */
export async function resolveDesiredRelease(
  input: DesiredReleaseInput,
  deps: DesiredReleaseDeps = defaultDeps,
): Promise<DesiredRelease> {
  // A push the warm mirror has not fetched must not be missed.
  invalidateProjectMirror(input.project.projectId);
  let baseSha: string;
  try {
    baseSha = await deps.resolveBase(input.project, input.baseRef);
  } catch (error) {
    throw new BaseRefUnresolvedError(input.baseRef, error as Error);
  }

  const base = await deps.build(input.project, baseSha, input.variant);
  let descriptor = toDescriptor(base, { repositoryAccess: input.repositoryAccess });
  let quarantinedReleaseId: string | null = null;
  const variantKey = ledgerVariant(input.variant, input.repositoryAccess);
  const projectId = input.project.projectId;

  if (descriptor.release_id) {
    try {
      const quarantined = await deps.ledger.quarantined(projectId, [descriptor.release_id], PROJECT_QUARANTINE_SESSIONS);
      if (quarantined.has(descriptor.release_id)) {
        const fallback = await deps.ledger.lastProven(projectId, variantKey, PROJECT_QUARANTINE_SESSIONS);
        if (fallback && fallback.releaseId !== descriptor.release_id) {
          const rebuilt = await deps.build(input.project, fallback.sourceCommit, input.variant);
          const candidate = toDescriptor(rebuilt, { repositoryAccess: input.repositoryAccess });
          // Assign the fallback only when the rebuild reproduces the proven ID.
          if (candidate.release_id === fallback.releaseId) {
            quarantinedReleaseId = descriptor.release_id;
            descriptor = candidate;
          }
        }
      }
    } catch (error) {
      // The ledger is bookkeeping. Without it the base release is assigned.
      console.warn(`[config-releases] quarantine lookup failed for ${projectId}: ${(error as Error).message}`);
    }
  }

  if (input.recordAssignment && descriptor.release_id && descriptor.source_commit) {
    await deps.ledger
      .recordAssigned({
        projectId,
        releaseId: descriptor.release_id,
        variant: variantKey,
        sourceCommit: descriptor.source_commit,
      })
      .catch((error: Error) =>
        console.warn(`[config-releases] recording assignment failed for ${projectId}: ${error.message}`),
      );
  }
  return { baseSha, descriptor, quarantinedReleaseId };
}
