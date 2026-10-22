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
import { parseManifestText, type ManifestFormat } from '@kortix/manifest-schema';

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
 * A session may merge its own change request only when its agent has an
 * explicit merge grant. Without this, an ungoverned agent (null grant) could
 * open and merge a change request to bypass the direct-push ref policy.
 *
 * A session merging a change request another actor opened still follows the
 * ordinary role and agent-scope gates on the route.
 */
export function refusesSelfMerge(input: {
  /** Session id of the acting token, or null for a person. */
  actingSessionId: string | null;
  /** The session the change request was opened from, if any. */
  originSessionId: string | null;
  /** Whether the agent's manifest explicitly grants project.gitops.merge. */
  hasExplicitMergeGrant: boolean;
}): boolean {
  return Boolean(input.actingSessionId)
    && input.actingSessionId === input.originSessionId
    && !input.hasExplicitMergeGrant;
}

/** Bind a session-opened CR to the authenticated session, not a body field. */
export function resolveChangeRequestOrigin(input: {
  actorIsSession: boolean;
  actingSessionId: string | null;
  requestedSessionId: string | null;
}): { ok: true; originSessionId: string | null } | { ok: false; code: string; error: string } {
  if (!input.actorIsSession) return { ok: true, originSessionId: input.requestedSessionId };
  if (!input.actingSessionId) {
    return { ok: false, code: 'CR_SESSION_ID_REQUIRED', error: 'Session identity is required.' };
  }
  if (input.requestedSessionId && input.requestedSessionId !== input.actingSessionId) {
    return {
      ok: false,
      code: 'CR_SESSION_ID_MISMATCH',
      error: 'session_id must match the authenticated session.',
    };
  }
  return { ok: true, originSessionId: input.actingSessionId };
}

/**
 * The permissions that writing these manifest sections takes on the direct
 * routes: agent blocks and the default agent (`PUT /agents/:name/config|scope`,
 * `PUT /default-agent`) and triggers (`POST|PATCH|DELETE /triggers`). A merge
 * that lands such a change needs the same permission, for an agent as for a
 * person. The Manager role lists them, and the role editor adds them to any
 * role that gets `project.gitops.merge` (its catalog `implies`); an agent's
 * `kortix_permissions` list is flat, so it must name them (or `all`).
 */
export const MANIFEST_WRITE_ACTIONS = [
  'project.agent.write',
  'project.trigger.create',
  'project.trigger.update',
  'project.trigger.delete',
] as const;

/**
 * Which of `MANIFEST_WRITE_ACTIONS` moving the manifest from `baseText` to
 * `headText` needs. Compared on parsed values, so formatting and key order do
 * not count. `null` = no manifest on that side. A side that does not parse
 * needs every one of them: the check fails closed.
 */
export function requiredManifestActions(
  baseText: string | null,
  headText: string | null,
  format: ManifestFormat,
  headFormat: ManifestFormat = format,
): string[] {
  const read = (text: string | null, fmt: ManifestFormat): Record<string, unknown> | null => {
    if (text === null || !text.trim()) return {};
    try {
      return parseManifestText(text, fmt);
    } catch {
      return null;
    }
  };
  const before = read(baseText, format);
  const after = read(headText, headFormat);
  if (before === null || after === null) return [...MANIFEST_WRITE_ACTIONS];
  const required = new Set<string>();
  if (
    canonicalJson(before.agents) !== canonicalJson(after.agents) ||
    canonicalJson(before.default_agent) !== canonicalJson(after.default_agent)
  ) {
    required.add('project.agent.write');
  }
  const was = triggersByKey(before.triggers);
  const now = triggersByKey(after.triggers);
  for (const [key, value] of now) {
    if (!was.has(key)) required.add('project.trigger.create');
    else if (was.get(key) !== value) required.add('project.trigger.update');
  }
  for (const key of was.keys()) if (!now.has(key)) required.add('project.trigger.delete');
  return MANIFEST_WRITE_ACTIONS.filter((action) => required.has(action));
}

/** Triggers keyed by slug (a list of `{slug}` or a slug-keyed map), each as canonical JSON. */
function triggersByKey(value: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      const slug = item && typeof item === 'object' ? (item as Record<string, unknown>).slug : undefined;
      out.set(typeof slug === 'string' ? slug : `#${index}`, canonicalJson(item));
    });
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) out.set(key, canonicalJson(item));
  }
  return out;
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}
