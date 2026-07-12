import { accountMembers } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { db } from '../../shared/db';
import { ensureAgentServiceAccount } from '../../repositories/service-accounts';

export async function resolveProjectAutomationActor(accountId: string): Promise<string | null> {
  const [row] = await db
    .select({ userId: accountMembers.userId })
    .from(accountMembers)
    .where(
      and(
        eq(accountMembers.accountId, accountId),
        eq(accountMembers.accountRole, 'owner'),
      ),
    )
    .limit(1);
  return row?.userId ?? null;
}

/**
 * Resolve the agent's standing-identity service account to ATTRIBUTE an
 * unattended automation run to (docs/specs/2026-07-05-agent-first-config-
 * unification.md §2.2 "runtime attribution", closing the `triggers.ts`
 * TODO). Deliberately narrow: this is for RUN ATTRIBUTION (`project_sessions
 * .created_by` — audit/identity, "who owns this run") only, resolved
 * AFTER the session already exists so it never touches the session's
 * provisioning/authorization actor — "attribution and authorization stop
 * sharing one field" (spec §2.2). The session's own executor token already
 * carries this SAME service account independently (`mintExecutorToken` in
 * platform/services/session-sandbox.ts calls `ensureAgentServiceAccount`
 * itself) and the standing-role fallback that keeps an unactivated agent's
 * session usable (`resolveActingActor` in iam/engine-v2.ts) is untouched by
 * this — it still resolves through the launching/automation actor, exactly
 * as before. Best-effort: a resolution failure returns null and the caller
 * leaves attribution at its prior value rather than failing the run.
 */
export async function resolveAgentRunAttribution(args: {
  accountId: string;
  projectId: string;
  agentName: string;
}): Promise<string | null> {
  try {
    return await ensureAgentServiceAccount({
      accountId: args.accountId,
      projectId: args.projectId,
      agentName: args.agentName,
    });
  } catch (err) {
    console.warn('[session-lifecycle] failed to resolve agent run attribution SA', {
      projectId: args.projectId,
      agentName: args.agentName,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
