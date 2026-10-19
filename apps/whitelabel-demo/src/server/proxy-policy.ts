/**
 * What a Lumen member may do through the proxy with their project-scoped
 * Kortix token. The token carries its minter's role on the project (owner)
 * and the minter's identity (the Lumen operator's Kortix user), so the proxy
 * narrows it to the session surface: an allowlist for reads and one for
 * writes. Everything else is refused. Project configuration (agents, secrets,
 * members, triggers, connectors, tokens, deletion) belongs to Lumen's
 * operator, and the operator's Kortix identity (accounts, members, access
 * lists) is not the member's to read.
 *
 * ponytail: a path allowlist here; Kortix narrowing a token's permissions
 * (contract proposal G2) would make it unnecessary.
 */

const PROJECT = '[^/]+';
// A session id is a UUID. A literal segment such as `warm` is a different route.
const SESSION = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/** A new session: the proxy tags it and records it as a Lumen thread. */
export const SESSION_CREATE = new RegExp(`^projects/${PROJECT}/sessions$`);

/** Calls the session UI makes either way: one session, its uploads, approvals and turns, and the runtime. */
const SESSION_SURFACE = [
  new RegExp(`^projects/${PROJECT}/sessions/${SESSION}(?:/.*)?$`),
  new RegExp(`^projects/${PROJECT}/(?:attachments|approvals)(?:/.*)?$`),
  new RegExp(`^projects/${PROJECT}/(?:turn-permission|turn-question|turn-stream)$`),
  // The session runtime (sandbox proxy).
  /^p\/.+$/,
];

/** Reads the session UI makes. Secrets, connections and models are lists of names. */
const ALLOWED_READS = [
  ...SESSION_SURFACE,
  new RegExp(`^projects/${PROJECT}(?:/(?:detail|sessions|change-requests|model-picker|connections|secrets|agents))?$`),
];

/** Writes the session UI makes. */
const ALLOWED_WRITES = [SESSION_CREATE, ...SESSION_SURFACE];

/** Null when allowed, else the reason for a 403. */
export function blockedReason(method: string, path: string): string | null {
  const read = method === 'GET' || method === 'HEAD';
  if (read) return ALLOWED_READS.some((re) => re.test(path)) ? null : 'Not available in Lumen';
  return ALLOWED_WRITES.some((re) => re.test(path))
    ? null
    : 'This workspace setting is managed by the Lumen operator';
}

const PERMISSION_PROBE = /^accounts\/[^/]+\/iam\/members\/[^/]+\/effective(:batch)?$/;
const DENIED = 'Managed by the Lumen operator';

interface Probe {
  action?: unknown;
  resourceType?: unknown;
  resourceId?: unknown;
}

function probeResult(p: Probe) {
  return {
    action: typeof p.action === 'string' ? p.action : '',
    resource_type: typeof p.resourceType === 'string' ? p.resourceType : 'account',
    resource_id: typeof p.resourceId === 'string' ? p.resourceId : null,
    allowed: false,
    reason: DENIED,
  };
}

/**
 * Account-level reads the session UI makes, answered by Lumen instead of
 * Kortix, or null to apply `blockedReason`. Kortix would answer them with
 * the operator's identity (`accounts/me`) or the operator's permissions
 * (`…/effective`), neither of which is the member's.
 *
 * - `GET accounts/me`: the Lumen user id, no email, no accounts.
 * - `…/effective` and `…/effective:batch`: every configuration action is
 *   denied, which is what a Lumen member may do. The UI hides those controls.
 */
export function localAnswer(
  method: string,
  path: string,
  query: URLSearchParams,
  body: unknown,
  member: { userId: string },
): Response | null {
  if (method === 'GET' && path === 'accounts/me') {
    return Response.json({ user_id: member.userId, email: '', accounts: [] });
  }
  const probe = PERMISSION_PROBE.exec(path);
  if (!probe) return null;
  if (method === 'GET' && !probe[1]) {
    return Response.json(
      probeResult({ action: query.get('action'), resourceType: query.get('resourceType'), resourceId: query.get('resourceId') }),
    );
  }
  if (method === 'POST' && probe[1]) {
    const probes = (body as { probes?: unknown } | null)?.probes;
    return Response.json({ results: Array.isArray(probes) ? probes.slice(0, 200).map((p) => probeResult(p as Probe)) : [] });
  }
  return null;
}
