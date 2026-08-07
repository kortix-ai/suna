import type { Database } from '@kortix/db';
import { projectTaskWorkerAdmissionState } from './generated-state-store';

/**
 * Bound, reserved, and stale runtime principals cannot create an independent
 * session through another control-plane surface.
 */
export async function taskWorkerDelegationDenied(
  database: Database,
  input: { callerSessionId: string | null; hasAgentGrant: boolean },
): Promise<boolean> {
  if (!input.callerSessionId) return input.hasAgentGrant;
  return (await projectTaskWorkerAdmissionState(database, input.callerSessionId)) !== 'not_worker';
}
