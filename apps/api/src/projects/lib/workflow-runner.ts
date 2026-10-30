/**
 * A workflow runner: the session a background `workflow` run goes on in
 * (kortixd `harness/pi/extensions/workflow.ts`, `background: true`). Its
 * runtime_context carries the run id under {@link WORKFLOW_RUN_ID_KEY}.
 *
 * My Kortix may not start another My Kortix session (META_AGENT_RECURSION),
 * with one exception: its own background workflow runs in a My Kortix runner,
 * so the run keeps My Kortix's rights and its hand-off to any project agent.
 * One level only: a runner never starts another runner.
 */
import { projectSessionRuntimeContexts } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { db } from '../../shared/db';

export const WORKFLOW_RUN_ID_KEY = 'kortix.workflow.run_id';

/** The create body's runtime_context names a workflow run. Pure. */
export function isWorkflowRunnerContext(runtimeContext: unknown): boolean {
  if (!runtimeContext || typeof runtimeContext !== 'object' || Array.isArray(runtimeContext)) return false;
  const runId = (runtimeContext as Record<string, unknown>)[WORKFLOW_RUN_ID_KEY];
  return typeof runId === 'string' && runId.trim() !== '';
}

/** The session is itself a workflow runner (its stored runtime_context names a run). */
export async function sessionIsWorkflowRunner(sessionId: string): Promise<boolean> {
  const [row] = await db
    .select({ context: projectSessionRuntimeContexts.context })
    .from(projectSessionRuntimeContexts)
    .where(eq(projectSessionRuntimeContexts.sessionId, sessionId))
    .limit(1);
  return isWorkflowRunnerContext(row?.context);
}
