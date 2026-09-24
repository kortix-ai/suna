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
  type ConfigReleaseAgentRepoint,
  type ConfigReleaseDescriptor,
  type ConfigReleaseVariant,
} from './builder';
import { loadAgentRosterAtCommit } from './agent-roster';
import { releaseVariantFor, resolveSessionReleaseAgent, type DeclaredAgentRoster } from './session-agent';
import { dbConfigReleaseLedger, PROJECT_QUARANTINE_SESSIONS, type ConfigReleaseLedger } from './quarantine';


export class BaseRefUnresolvedError extends Error {
  constructor(readonly baseRef: string, cause: Error) {
    super(`base ref ${baseRef} does not resolve: ${cause.message}`);
    this.name = 'BaseRefUnresolvedError';
  }
}

export interface DesiredReleaseInput {
  project: GitBackedProject;
  baseRef: string;
  /** `project_sessions.agent_name` — the agent the session IS. */
  sessionAgent: string | null;
  /** The descriptor carries an archive only with repository access. */
  repositoryAccess: boolean;
  /** Record the assignment. Only the daemon's own request records it. */
  recordAssignment?: boolean;
  /**
   * May the session's OWNER run `agent`? Asked only when the manifest dropped
   * the session's agent and a declared default exists to move it to. Omitted ⇒
   * the answer is no, so a caller that cannot ask never widens anything.
   */
  ownerMayUseAgent?: (agent: string) => Promise<boolean>;
  /**
   * Persist the re-point. Supplied ONLY by the daemon's own descriptor
   * request, so a human read decides and reports without writing.
   */
  persistRepoint?: (from: string, to: string) => Promise<boolean>;
}

export interface DesiredRelease {
  baseSha: string;
  descriptor: ConfigReleaseDescriptor;
  /** The base release ID the project quarantined, when a fallback replaced it. */
  quarantinedReleaseId: string | null;
  /** The variant the release was built for, after the agent resolution. */
  variant: ConfigReleaseVariant;
}

export interface DesiredReleaseDeps {
  ledger: ConfigReleaseLedger;
  build: typeof buildConfigRelease;
  resolveBase: (project: GitBackedProject, ref: string) => Promise<string>;
  /** What the manifest declares at the release's own commit. */
  loadRoster: (project: GitBackedProject, commit: string) => Promise<DeclaredAgentRoster>;
}

const defaultDeps: DesiredReleaseDeps = {
  ledger: dbConfigReleaseLedger,
  build: (project, commit, variant, options) => buildConfigRelease(project, commit, variant, options),
  resolveBase: resolveCommitSha,
  loadRoster: loadAgentRosterAtCommit,
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

  // ── Which agent is this session, at THIS commit ────────────────────────
  // The one place the answer is decided (config-releases/session-agent.ts).
  // A session whose agent the manifest dropped is re-pointed to the project's
  // declared default — audited and persisted by the daemon's own request —
  // instead of compiling an undeclared name, which fails and leaves the box
  // with `release_id: null` and no config at all.
  const roster = await deps.loadRoster(input.project, baseSha);
  const decision = resolveSessionReleaseAgent(input.sessionAgent, roster);
  let agent: string | null;
  let agentRepoint: ConfigReleaseAgentRepoint | null = null;
  if (decision.kind === 'declared') {
    agent = decision.agent;
  } else if (decision.kind === 'orphaned') {
    agent = null;
    agentRepoint = {
      from: decision.dropped,
      to: null,
      applied: false,
      reason:
        `This project's configuration no longer declares the agent "${decision.dropped}" this session was created with, ` +
        'and the project declares no default agent to move it to. The session runs without an agent and holds no agent ' +
        'access. Declare the agent again, or set a default agent for the project.',
    };
  } else {
    const allowed = input.ownerMayUseAgent ? await input.ownerMayUseAgent(decision.agent) : false;
    if (allowed) await input.persistRepoint?.(decision.dropped, decision.agent);
    agent = allowed ? decision.agent : null;
    agentRepoint = {
      from: decision.dropped,
      to: decision.agent,
      applied: allowed,
      reason: allowed
        ? `This project's configuration no longer declares the agent "${decision.dropped}" this session was created with. ` +
          `The session now runs the project's default agent, "${decision.agent}".`
        : `This project's configuration no longer declares the agent "${decision.dropped}" this session was created with, ` +
          `and this session's owner may not run the project's default agent, "${decision.agent}". The session runs without ` +
          'an agent and holds no agent access. Ask a project manager for access to that agent.',
    };
  }
  const variant = releaseVariantFor(agent, input.repositoryAccess);

  const base = await deps.build(input.project, baseSha, variant);
  let descriptor = toDescriptor(base, { repositoryAccess: input.repositoryAccess, agentRepoint });
  let quarantinedReleaseId: string | null = null;
  const variantKey = ledgerVariant(variant, input.repositoryAccess);
  const projectId = input.project.projectId;

  if (descriptor.release_id) {
    try {
      const quarantined = await deps.ledger.quarantined(projectId, [descriptor.release_id], PROJECT_QUARANTINE_SESSIONS);
      if (quarantined.has(descriptor.release_id)) {
        const fallback = await deps.ledger.lastProven(projectId, variantKey, PROJECT_QUARANTINE_SESSIONS);
        if (fallback && fallback.releaseId !== descriptor.release_id) {
          const rebuilt = await deps.build(input.project, fallback.sourceCommit, variant);
          const candidate = toDescriptor(rebuilt, { repositoryAccess: input.repositoryAccess, agentRepoint });
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
  return { baseSha, descriptor, quarantinedReleaseId, variant };
}
