/**
 * What a Lumen member may do through the proxy with their project-scoped
 * Kortix token. The token carries its minter's role on the project (owner),
 * so the proxy narrows it: reads are open, writes are an allowlist of the
 * session surface. Project configuration (agents, secrets, members, triggers,
 * connectors, tokens, deletion) belongs to Lumen's operator, not its users.
 *
 * ponytail: a path allowlist here; Kortix narrowing a token's permissions
 * (contract proposal G2) would make it unnecessary.
 */

const PROJECT = '[^/]+';

/** Reads that hand out a credential. */
const BLOCKED_READS = [new RegExp(`^projects/${PROJECT}/(?:cli-token|git-token|git-credential)$`)];

/** A new session: the proxy tags it and records it as a Lumen thread. */
export const SESSION_CREATE = new RegExp(`^projects/${PROJECT}/sessions$`);

/** Writes a member makes from the session UI. */
const ALLOWED_WRITES = [
  SESSION_CREATE,
  // Everything scoped to one existing session: prompts, aborts, rescope, shares, attachments, …
  new RegExp(`^projects/${PROJECT}/sessions/[^/]+(?:/.*)?$`),
  new RegExp(`^projects/${PROJECT}/(?:attachments|approvals)(?:/.*)?$`),
  new RegExp(`^projects/${PROJECT}/(?:turn-permission|turn-question|turn-stream)$`),
  // The session runtime (sandbox proxy) and its preview shares.
  /^p\/.+$/,
];

/** Null when allowed, else the reason for a 403. */
export function blockedReason(method: string, path: string): string | null {
  const read = method === 'GET' || method === 'HEAD';
  if (read) {
    return BLOCKED_READS.some((re) => re.test(path)) ? 'Credentials are not issued through Lumen' : null;
  }
  return ALLOWED_WRITES.some((re) => re.test(path))
    ? null
    : 'This workspace setting is managed by the Lumen operator';
}
