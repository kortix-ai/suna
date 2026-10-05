/**
 * Rule 4 — admission control, wired to a REAL running box.
 *
 * The one piece `admit-sandbox.ts` deliberately does not own: dialing the box
 * and resolving this project's desired release. Called from the ONE chokepoint
 * every session-open path shares — `runOpenSession` (routes/shared.ts) — right
 * before it would hand a confirmed-running box to the session as `stage:
 * 'ready'`. A pooled or resumed box is exactly the risk (spec §"Rule 4"): a
 * freshly created box boots the current image by construction, but a box that
 * already existed may predate every capability this deploy ships.
 *
 * NEVER throws: a caller that cannot evaluate admission (a git-mirror hiccup,
 * a health fetch failure) gets `{ admitted: true }` rather than blocking every
 * session open on this gate's own availability — the same shape as every other
 * "must not throw" convergence lane in this codebase
 * (`convergeBeforeTurnStart`, `convergeAssetsInBackground`). A box that FAILED
 * to answer at all is handled inside `evaluateAdmission` via
 * `parseActualRuntime`'s tolerant "reports nothing" default, which refuses —
 * this catch is for the admission PLUMBING breaking, not for the box.
 */

import { logger } from '../lib/logger';
import type { GitBackedProject } from '../projects/git/types';
import { resolveDesiredRelease } from '../config-releases/desired';
import { sandboxOpencodeEndpoint } from '../projects/opencode-mapping';
import { sandboxRuntimeRequestHeaders } from '../projects/sandbox-fetch';
import { admitSandboxForSession } from './admit-sandbox';
import { runtimeAdmissionEnforced, type RuntimeAdmissionVerdict } from './admission';

export interface AdmitRunningSandboxInput {
  externalId: string;
  userId: string | undefined;
  project: GitBackedProject;
  baseRef: string;
  sessionAgent: string | null;
  repositoryAccess: boolean;
  /** Logged on refusal. A class-safe label, never a raw customer identifier. */
  sessionId: string;
}

export interface AdmitRunningSandboxDeps {
  fetchHealth: (
    externalId: string,
    userId: string | undefined,
  ) => Promise<{ capabilities?: unknown; runtime_truth?: unknown } | null>;
  resolveReleaseId: (input: AdmitRunningSandboxInput) => Promise<string | null>;
}

async function defaultFetchHealth(
  externalId: string,
  userId: string | undefined,
): Promise<{ capabilities?: unknown; runtime_truth?: unknown } | null> {
  const ep = await sandboxOpencodeEndpoint(externalId, userId);
  if (!ep) return null;
  try {
    const res = await fetch(`${ep.url}/kortix/health`, {
      headers: sandboxRuntimeRequestHeaders(ep.headers),
      // Matches `listSandboxOpencodeSessions`'s budget: a healthy daemon
      // answers in well under a second; this call sits on the session-open
      // path, so a wedged connection must fail fast rather than stall it.
      signal: AbortSignal.timeout(3_000),
    });
    if (!res.ok) return null;
    return (await res.json()) as { capabilities?: unknown; runtime_truth?: unknown };
  } catch {
    return null;
  }
}

async function defaultResolveReleaseId(input: AdmitRunningSandboxInput): Promise<string | null> {
  try {
    const desired = await resolveDesiredRelease({
      project: input.project,
      baseRef: input.baseRef,
      sessionAgent: input.sessionAgent,
      repositoryAccess: input.repositoryAccess,
    });
    return desired.descriptor.release_id;
  } catch {
    return null;
  }
}

const defaultDeps: AdmitRunningSandboxDeps = {
  fetchHealth: defaultFetchHealth,
  resolveReleaseId: defaultResolveReleaseId,
};

export async function admitRunningSandbox(
  input: AdmitRunningSandboxInput,
  deps: AdmitRunningSandboxDeps = defaultDeps,
): Promise<RuntimeAdmissionVerdict> {
  try {
    const health = await deps.fetchHealth(input.externalId, input.userId);
    return await admitSandboxForSession(
      { health },
      {
        releaseId: () => deps.resolveReleaseId(input),
        onRefused: (event) => {
          const enforced = runtimeAdmissionEnforced();
          logger[enforced ? 'error' : 'warn'](
            enforced
              ? '[runtime-convergence] admission refused — box replaced, not used'
              : '[runtime-convergence] admission refused — observe only, box still used',
            { session_id: input.sessionId, failed_check: event.failedCheck, cause: event.cause },
          );
        },
      },
    );
  } catch (error) {
    logger.warn('[runtime-convergence] admission check itself failed; not blocking session open', {
      session_id: input.sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { admitted: true };
  }
}
