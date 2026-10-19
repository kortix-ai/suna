/** What one gateway answer means for a poll stream. Pure. */
import type { CallResult } from '../../connectors/gateway';
import { UPSTREAM_TIMEOUT } from '../../connectors/gateway';
import type { PollErrorKind } from './poll-store';

/** Below the poll lease (3 min), so a slow vendor cannot outlive the claim. */
export const CALL_TIMEOUT_MS = 30_000;
const HOUR_MS = 60 * 60_000;

/** The account is gone or not signed in: a person must reconnect it. */
const NEEDS_CONNECTION = new Set([
  'needs_auth',
  'connector_not_connected',
  'account_required',
  'account_not_found',
  'credential_not_shared',
  'credential_undecryptable',
]);

export type Outcome = { kind: 'ok' } | { kind: PollErrorKind; message: string; retryAfterSeconds?: number };

const oneLine = (text: string, max = 300): string => text.replace(/\s+/g, ' ').trim().slice(0, max);

/** What one gateway answer means for the stream. 401/403 are transient: only the issuer's own refusal parks it. */
export function classifyCall(result: CallResult, label: string, slug: string, tool: string): Outcome {
  switch (result.status) {
    case 'ok':
      return result.upstreamError
        ? { kind: 'transient', message: `${label} reported an error: ${oneLine(result.upstreamError, 200)}` }
        : { kind: 'ok' };
    case 'denied':
      if (NEEDS_CONNECTION.has(result.reason)) {
        return { kind: 'needs_connection', message: `The shared ${label} account is not signed in. Reconnect it to resume this trigger.` };
      }
      if (result.reason === 'connector_not_found' || result.reason === 'connector_disabled') {
        return { kind: 'fatal', message: `Connector "${slug}" is missing or turned off.` };
      }
      if (result.reason === 'action_not_found') {
        return { kind: 'fatal', message: `${label} does not offer the read-only tool ${tool}. Reconnect ${label} so Kortix reads its tools again.` };
      }
      if (result.reason === 'policy_block') {
        return { kind: 'fatal', message: `A connector policy blocks ${slug}.${tool}, so this trigger cannot check ${label}. Allow the tool, or remove the trigger.` };
      }
      return { kind: 'fatal', message: `${label} refused the check: ${oneLine(result.message ?? result.reason)}` };
    case 'pending_approval':
      return {
        kind: 'fatal',
        message: `${slug}.${tool} needs approval on each call, so this trigger cannot check ${label} unattended. Add a connector policy that lets ${tool} run.`,
      };
    case 'error': {
      const reason = oneLine(result.reason, 200);
      if (/invalid_grant|requires reconnection/i.test(result.reason)) {
        return { kind: 'needs_connection', message: `The shared ${label} account is not signed in. Reconnect it to resume this trigger.` };
      }
      const status = result.upstreamStatus;
      if (status === 400 || status === 404 || status === 422) {
        return { kind: 'fatal', message: `${label} rejected the check (${status}): ${reason}. Check the event settings.` };
      }
      if (status === 429) {
        return { kind: 'transient', message: `${label} limited the request rate.`, retryAfterSeconds: result.retryAfterSeconds };
      }
      if (result.reason.startsWith(UPSTREAM_TIMEOUT)) return { kind: 'transient', message: `${label} did not answer within ${CALL_TIMEOUT_MS / 1000} s.` };
      return { kind: 'transient', message: status ? `${label} answered ${status}: ${reason}` : `${label} could not be reached: ${reason}` };
    }
  }
}

/** Backoff after `failures` transient failures in a row: never sooner than the interval, never later than 1 h past it. */
export function backoffMs(intervalMs: number, failures: number, retryAfterSeconds?: number): number {
  const exponential = Math.min(60_000 * 2 ** Math.max(0, failures - 1), HOUR_MS);
  return Math.min(Math.max(intervalMs, exponential, (retryAfterSeconds ?? 0) * 1000), intervalMs + HOUR_MS);
}

