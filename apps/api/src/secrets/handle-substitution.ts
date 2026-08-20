/**
 * What the sandbox PRESENTED, judged against what this session may spend.
 *
 * Substitution itself is byte work and lives in `http-broker.ts`. This module
 * answers the different question the audit record needs: a handle turned up in
 * a relayed request and was NOT honored — why not? The three answers are three
 * different incidents:
 *
 *  - `forged`      — the HMAC tag does not verify. Nobody minted this. Someone
 *                    in the guest is guessing at handle shapes.
 *  - `stolen`      — the tag verifies, but the handle is not one of THIS
 *                    session's active handles. It was minted for another
 *                    session (or for a secret this agent's grant excludes) and
 *                    carried here.
 *  - `host_denied` — the session may spend it, but its frozen policy does not
 *                    admit this destination. Ordinary policy at work.
 *
 * Collapsing them into "not substituted" is how a live credential-theft attempt
 * becomes indistinguishable from a misconfigured host list.
 *
 * Pure and I/O-free, in the same spirit as `strategy.ts`: the caller does the
 * database work and hands the facts in.
 */
import { findHandleCandidates, parseHandle } from './strategy';

export type HandleRefusalReason = 'forged' | 'stolen' | 'host_denied';

export interface PresentedHandleRefusal {
  reason: HandleRefusalReason;
  /** Known only once the tag verifies AND the handle belongs to this session. */
  identifier: string | null;
  /** Null for a forged handle: `parseHandle` does not return a lookup id it
   *  could not authenticate, and echoing an attacker-chosen one would put
   *  unverified input in the audit trail as if it were a record. */
  lookup_id: string | null;
}

/** What the caller knows about one of this session's own active handles. */
export interface SessionHandleFacts {
  identifier: string;
  /** The agent grant ∩ the session allowlist admit this secret. */
  spendable: boolean;
  /** The handle's FROZEN policy snapshot admits this request's destination. */
  hostAdmitted: boolean;
}

/**
 * The request surfaces a handle can travel in, as one string to scan.
 *
 * Header values, the URL's path and query, and the body — the same three
 * surfaces substitution rewrites. The body is read as UTF-8 because a handle is
 * ASCII by construction; binary bytes simply do not match.
 */
export function requestSurfaceText(input: {
  url: string;
  headers?: Record<string, string>;
  body?: Buffer | null;
}): string {
  const parts: string[] = [input.url];
  for (const value of Object.values(input.headers ?? {})) parts.push(value);
  if (input.body && input.body.byteLength > 0) parts.push(input.body.toString('utf8'));
  return parts.join('\n');
}

/**
 * Every handle in the request that was NOT honored, and why.
 *
 * The tag is verified FIRST, before the session map is consulted, so a forged
 * handle never reaches a lookup — the same ordering `parseHandle` documents for
 * the broker itself.
 */
export function classifyPresentedHandles(
  surface: string,
  sessionHandles: ReadonlyMap<string, SessionHandleFacts>,
  rootSecret: string,
): PresentedHandleRefusal[] {
  const refusals: PresentedHandleRefusal[] = [];
  for (const candidate of findHandleCandidates(surface)) {
    const parsed = parseHandle(candidate, rootSecret);
    if (!parsed.ok) {
      // `not_a_handle` cannot occur for a scanner match (the shape is what the
      // scanner matched), so a failure here is always a bad tag.
      refusals.push({ reason: 'forged', identifier: null, lookup_id: null });
      continue;
    }
    const known = sessionHandles.get(parsed.lookupId);
    if (!known || !known.spendable) {
      refusals.push({
        reason: 'stolen',
        identifier: known?.identifier ?? null,
        lookup_id: parsed.lookupId,
      });
      continue;
    }
    if (!known.hostAdmitted) {
      refusals.push({
        reason: 'host_denied',
        identifier: known.identifier,
        lookup_id: parsed.lookupId,
      });
    }
  }
  return refusals;
}

/** Counts by reason — the compact shape an audit record carries. */
export function summarizeHandleRefusals(
  refusals: readonly PresentedHandleRefusal[],
): Record<HandleRefusalReason, number> | null {
  if (refusals.length === 0) return null;
  const summary: Record<HandleRefusalReason, number> = {
    forged: 0,
    stolen: 0,
    host_denied: 0,
  };
  for (const refusal of refusals) summary[refusal.reason] += 1;
  return summary;
}
