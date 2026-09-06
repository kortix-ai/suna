/**
 * Change-request authorization decisions that are ABOUT the session, not about
 * the caller's role — pure, no I/O, so both are testable and neither can drift
 * into a route handler where nobody finds it.
 *
 * These are the second half of the git ref policy. `git-proxy/ref-policy.ts`
 * stops a session pushing anywhere but its own branch; without the two rules
 * here that would be one hop from useless, because a change request is the
 * sanctioned way to move commits onto another branch and the merge writes that
 * branch SERVER-side, never passing through the proxy at all.
 */

/** Which branch does a change request opened from a session target? */
export type CrBaseDecision =
  | { ok: true; baseRef: string }
  | { ok: false; code: string; error: string };

export function resolveChangeRequestBase(input: {
  /** `base_ref` as supplied by the caller, if any. */
  requested: string | null;
  /** The originating session's own base, when the CR is attached to a session. */
  sessionBase: string | null;
  /** The project's default branch. */
  projectDefault: string;
  /** True when the caller is a session/agent principal rather than a person. */
  actorIsSession: boolean;
}): CrBaseDecision {
  // A change request opened from a session targets the branch that session was
  // STARTED from — not the project default. Those differ whenever a team keeps
  // a long-lived branch as its trunk and the default branch for production: a
  // session branched off `dev` used to produce a change request into `main`,
  // proposing to ship to production work only ever meant for `dev`.
  const derived = input.sessionBase ?? input.projectDefault;
  if (!input.requested) return { ok: true, baseRef: derived };
  if (input.requested === derived) return { ok: true, baseRef: derived };
  // A person may retarget: choosing where work lands is a review decision, and
  // `kortix cr open --base` is how it is made. An agent may not — otherwise the
  // rule is advisory and the first thing a confused agent does is aim at main.
  if (input.actorIsSession) {
    return {
      ok: false,
      code: 'CR_BASE_NOT_SESSION_BASE',
      error:
        `This session was started from "${derived}", so its change request targets "${derived}" — ` +
        `it cannot be retargeted at "${input.requested}". ` +
        'Ask the user to open the change request against a different base.',
    };
  }
  return { ok: true, baseRef: input.requested };
}

/**
 * May this caller merge this change request?
 *
 * A session may not merge the change request it opened. Without this an agent
 * refused a direct push to `main` could open a change request onto `main` and
 * merge it a second later, landing exactly the same commits with no human in
 * the loop — the ref policy defeated by one extra HTTP call.
 *
 * Structural, not configured: it holds on ungoverned projects too, where the
 * per-agent grant is null and `assertAgentScope` is a no-op. An agent merging a
 * change request a PERSON opened stays allowed — that is a reviewed merge
 * someone asked for.
 */
export function refusesSelfMerge(input: {
  /** Session id of the acting token, or null for a person. */
  actingSessionId: string | null;
  /** The session the change request was opened from, if any. */
  originSessionId: string | null;
}): boolean {
  return Boolean(input.actingSessionId) && input.actingSessionId === input.originSessionId;
}
