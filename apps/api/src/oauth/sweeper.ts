// Hourly housekeeping for the OAuth tables: expired authorization requests and
// abandoned self-registered clients (B-9). Both deletes are bounded, idempotent
// and safe when several API tasks run them: a row a peer already deleted is not
// matched. worker/jobs/oauth-sweep.ts schedules the pass. This module imports
// no route and no middleware, so the worker loads none of the OAuth routes.

import { sql } from 'drizzle-orm';
import { db } from '../shared/db';

/** A pending authorization request lives this long. */
export const AUTH_REQUEST_TTL_MS = 10 * 60 * 1000;

export const SELF_REGISTERED_DESCRIPTION = 'Self-registered (RFC 7591 dynamic client registration)';

/** Housekeeping: drop expired or consumed requests older than the TTL, at most `limit` per run. */
export async function sweepExpiredAuthorizationRequests(
  now = new Date(),
  limit = SWEEP_BATCH,
): Promise<number> {
  const cutoff = new Date(now.getTime() - AUTH_REQUEST_TTL_MS);
  const rows = await db.execute(sql`
    delete from kortix.oauth_authorization_requests
     where id in (
       select id from kortix.oauth_authorization_requests
        where expires_at < ${now.toISOString()}::timestamptz or created_at < ${cutoff.toISOString()}::timestamptz
        limit ${limit})
    returning id`);
  return countRows(rows);
}

/** A self-registered client that no person ever approved and that never got a token is dropped after this long. */
const ABANDONED_CLIENT_AGE_MS = 7 * 24 * 3600 * 1000;
const SWEEP_BATCH = 500;

const countRows = (r: unknown): number =>
  ((r as { rows?: unknown[] }).rows ?? (r as unknown[])).length;

/**
 * Housekeeping (B-9): open dynamic registration (RFC 7591) lets anyone create
 * client rows. Delete those older than 7 days with no consent and no token
 * ever issued. Codes and requests cascade. One DELETE, bounded by `limit`;
 * concurrent runs on several API tasks delete disjoint-or-equal rows, and a row
 * already deleted by a peer is simply not matched, so the run is idempotent.
 */
export async function sweepAbandonedSelfRegisteredClients(
  now = new Date(),
  limit = SWEEP_BATCH,
): Promise<number> {
  const cutoff = new Date(now.getTime() - ABANDONED_CLIENT_AGE_MS);
  const rows = await db.execute(sql`
    delete from kortix.oauth_clients
     where client_id in (
       select c.client_id from kortix.oauth_clients c
        where c.description = ${SELF_REGISTERED_DESCRIPTION}
          and c.account_id is null and c.app_id is null
          and c.created_at < ${cutoff.toISOString()}::timestamptz
          and not exists (select 1 from kortix.oauth_consents o where o.client_id = c.client_id)
          and not exists (select 1 from kortix.oauth_access_tokens t where t.client_id = c.client_id)
        limit ${limit})
    returning client_id`);
  return countRows(rows);
}

export async function runOAuthSweepOnce(): Promise<{ requests: number; clients: number }> {
  return { requests: await sweepExpiredAuthorizationRequests(), clients: await sweepAbandonedSelfRegisteredClients() };
}
