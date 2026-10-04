// Hourly housekeeping for the OAuth tables: expired authorization requests and
// abandoned self-registered clients (B-9). Both deletes are bounded, idempotent
// and safe when several API tasks run them: a row a peer already deleted is not
// matched. The timer is in workers/oauth-sweep.ts.

import { sweepAbandonedSelfRegisteredClients, sweepExpiredAuthorizationRequests } from './requests';

export async function runOAuthSweepOnce(): Promise<{ requests: number; clients: number }> {
  return { requests: await sweepExpiredAuthorizationRequests(), clients: await sweepAbandonedSelfRegisteredClients() };
}
