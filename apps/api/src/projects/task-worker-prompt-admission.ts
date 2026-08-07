import type { Database } from '@kortix/db';
import {
  type ProjectTaskWorkerBinding,
  getProjectTaskWorkerBinding,
  projectTaskWorkerAdmissionState,
} from './generated-state-store';

export type ProjectTaskWorkerPromptAdmission =
  | { state: 'not_worker' }
  | { state: 'spawned_unbound' }
  | { state: 'bound'; binding: ProjectTaskWorkerBinding };

/**
 * Classify prompt admission for a task worker.
 *
 * Ordinary sessions are not workers. A metadata-marked child fails closed until
 * its task binding commits. Bound workers may prompt only while their task is
 * doing. The caller must inspect the bound task status.
 */
export async function projectTaskWorkerPromptAdmission(
  database: Database,
  workerSessionId: string,
): Promise<ProjectTaskWorkerPromptAdmission> {
  const state = await projectTaskWorkerAdmissionState(database, workerSessionId);
  if (state !== 'bound') return { state };

  const binding = await getProjectTaskWorkerBinding(database, workerSessionId);
  // The binding disappeared between the classification and binding reads.
  // Fail closed exactly like a spawned child whose registration has not committed.
  if (!binding) return { state: 'spawned_unbound' };
  return { state: 'bound', binding };
}

export function taskWorkerPromptIsAllowed(admission: ProjectTaskWorkerPromptAdmission): boolean {
  return (
    admission.state === 'not_worker' ||
    (admission.state === 'bound' && admission.binding.status === 'doing')
  );
}
