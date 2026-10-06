// Hourly housekeeping for the OAuth tables: expired authorization requests and
// abandoned self-registered clients (B-9). Both deletes are bounded, idempotent
// and safe when several API tasks run them: a row a peer already deleted is not
// matched. workers/oauth-sweep-worker.ts schedules the pass.

import { sweepAbandonedSelfRegisteredClients, sweepExpiredAuthorizationRequests } from './index';

export async function runOAuthSweepOnce(): Promise<{ requests: number; clients: number }> {
  return { requests: await sweepExpiredAuthorizationRequests(), clients: await sweepAbandonedSelfRegisteredClients() };
}

export { startOAuthSweeper, stopOAuthSweeper } from '../workers/oauth-sweep-worker';
