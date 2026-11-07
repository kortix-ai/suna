/**
 * "Delete my account": the PERSON's routes under `/v1/account` (review
 * finding 2; design.md §3.1 item 2, §3.2 C5). Every route keys on the
 * signed-in user. None picks a workspace for them: deleting a workspace is
 * `DELETE /v1/workspaces/:id`.
 *
 *   GET    /deletion-plan       what deleting the person would do (PersonDeletionPlan)
 *   DELETE /delete-immediately  run the plan now; the login goes last
 *   POST   /request-deletion    schedule the plan 14 days out (person_deletion_requests)
 *   POST   /cancel-deletion     cancel the scheduled deletion
 *   GET    /deletion-status     the scheduled deletion, if any
 *
 * A sole owner of a workspace other people use gets 409
 * `sole_owner_of_shared_workspace` with that workspace list, before any write.
 * Only a person deletes themselves: a browser session or an unscoped personal
 * token, never an API key, a workspace-bound token or an impersonating
 * operator. A legacy pending ACCOUNT request of the person's personal account
 * (`account_id = user_id`, from before Workspaces D3) is still reported and
 * cancellable here.
 */
import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';

import { auth, json, makeOpenApiApp } from '../../openapi';
import { impersonatedAccountFor } from '../../shared/impersonation';
import { readJsonObject } from '../../shared/http-body';
import { noWorkspaceError } from '../../shared/no-workspace';
import type { AppEnv } from '../../types';
import {
  cancelPersonDeletion,
  deletePerson,
  getPersonDeletionRequest,
  planPersonDeletion,
  SoleOwnerOfSharedWorkspaceError,
  type PersonDeletionPlan,
} from '../../workspaces/surface';
import { cancelAccountDeletion, getAccountDeletionStatus } from '../services/account-deletion';

export const accountDeletionRouter = makeOpenApiApp<AppEnv>();

const GRACE_PERIOD_DAYS = 14;

// Opaque service results (status / success payloads) — permissive on purpose.
const ResultSchema = z.record(z.string(), z.any());

const PlanSchema = z.object({
  delete_workspaces: z.array(z.string()).openapi({ description: 'Workspaces deleted with you: you are their only owner and only member.' }),
  leave_workspaces: z.array(z.string()).openapi({ description: 'Workspaces you leave; they stay for their other members.' }),
  blockers: z
    .array(z.object({ workspace_id: z.string(), name: z.string(), member_count: z.number().int() }))
    .openapi({ description: 'Workspaces where you are the only owner and other people are members. Make someone else an owner, or delete the workspace, first.' }),
  workspace_names: z.record(z.string(), z.string()).openapi({ description: 'The name of every workspace listed above.' }),
});

function planBody(plan: PersonDeletionPlan) {
  return {
    delete_workspaces: plan.deleteWorkspaces.map(String),
    leave_workspaces: plan.leaveWorkspaces.map(String),
    blockers: plan.blockers.map((b) => ({ workspace_id: b.workspaceId, name: b.name, member_count: b.memberCount })),
    workspace_names: plan.names ?? {},
  };
}

function soleOwnerBody(error: SoleOwnerOfSharedWorkspaceError) {
  return {
    error: error.message,
    message: error.message,
    status: 409,
    code: error.code,
    workspaces: error.blockers.map((b) => ({ workspace_id: b.workspaceId, name: b.name, member_count: b.memberCount })),
  };
}

/** The 403 for a caller that is not a person acting for themselves, else null. */
function personDenial(c: Context<AppEnv>): { error: string; code: string } | null {
  const userId = c.get('userId') as string;
  if (impersonatedAccountFor(userId)) {
    return { error: 'Impersonated requests cannot delete a person', code: 'impersonation_invalid' };
  }
  const authType = c.get('authType') as string | undefined;
  const scoped = Boolean((c as unknown as { get(k: string): unknown }).get('tokenProjectId'));
  if ((authType !== 'supabase' && authType !== 'pat') || scoped) {
    return { error: 'Only you can delete your account: sign in, or use an unscoped personal access token', code: 'person_credential_required' };
  }
  return null;
}

/** A legacy pending request on the person's personal account (`account_id = user_id`). */
async function legacyPersonalStatus(userId: string) {
  try {
    return await getAccountDeletionStatus(userId);
  } catch {
    return null;
  }
}

accountDeletionRouter.openapi(
  createRoute({
    method: 'get',
    path: '/deletion-plan',
    tags: ['billing'],
    summary: 'What deleting your account would do',
    description:
      'The workspaces deleted with you (you are their only owner and only member), the workspaces you leave, and the workspaces that block the deletion (you are their only owner and other people are members).',
    ...auth,
    responses: { 200: json(PlanSchema, 'The deletion plan') },
  }),
  async (c: Context<AppEnv>) => {
    const plan = await planPersonDeletion(c.get('userId') as string);
    return c.json(planBody(plan), 200);
  },
);

accountDeletionRouter.openapi(
  createRoute({
    method: 'get',
    path: '/deletion-status',
    tags: ['billing'],
    summary: 'Get the current account-deletion status',
    ...auth,
    responses: { 200: json(ResultSchema, 'Account deletion status') },
  }),
  async (c: Context<AppEnv>) => {
    const userId = c.get('userId') as string;
    const request = await getPersonDeletionRequest(userId);
    if (request) {
      return c.json({
        has_pending_deletion: true,
        deletion_scheduled_for: request.scheduledFor.toISOString(),
        requested_at: request.requestedAt.toISOString(),
        can_cancel: request.status === 'pending',
      });
    }
    const legacy = await legacyPersonalStatus(userId);
    if (legacy?.has_pending_deletion) return c.json(legacy);
    return c.json({ has_pending_deletion: false, deletion_scheduled_for: null, requested_at: null, can_cancel: false });
  },
);

accountDeletionRouter.openapi(
  createRoute({
    method: 'post',
    path: '/request-deletion',
    tags: ['billing'],
    summary: 'Schedule the deletion of your account',
    description:
      'Schedules your deletion 14 days out and ends your sign-ins; sign in again to cancel. At the date, the workspaces you own alone are deleted, you leave the others, and your login is deleted. 409 `sole_owner_of_shared_workspace` while you are the only owner of a workspace other people use.',
    ...auth,
    request: {
      body: {
        required: false,
        content: { 'application/json': { schema: z.object({ reason: z.string().optional() }) } },
      },
    },
    responses: {
      200: json(ResultSchema, 'Deletion request result'),
      403: json(ResultSchema, 'Not a person acting for themselves'),
      409: json(ResultSchema, 'Sole owner of a shared workspace'),
    },
  }),
  async (c: Context<AppEnv>) => {
    const denial = personDenial(c);
    if (denial) return c.json(denial, 403);
    // Tolerant body: optional, missing or invalid JSON reads as {}.
    await readJsonObject(c);
    // A login with no workspace has nothing to keep for a grace period: the
    // client deletes it immediately instead (DELETE /delete-immediately).
    const plan = await planPersonDeletion(c.get('userId') as string);
    if (plan.deleteWorkspaces.length + plan.leaveWorkspaces.length + plan.blockers.length === 0) {
      throw noWorkspaceError('You belong to no workspace, so nothing waits for a grace period. Delete your account immediately instead.');
    }
    try {
      const { plan, scheduledFor } = await deletePerson(c.get('userId') as string, 'scheduled');
      return c.json({
        success: true,
        message: 'Account deletion scheduled successfully',
        deletion_scheduled_for: scheduledFor?.toISOString() ?? null,
        can_cancel: true,
        grace_period_days: GRACE_PERIOD_DAYS,
        plan: planBody(plan),
      });
    } catch (error) {
      if (error instanceof SoleOwnerOfSharedWorkspaceError) return c.json(soleOwnerBody(error), 409);
      throw error;
    }
  },
);

accountDeletionRouter.openapi(
  createRoute({
    method: 'post',
    path: '/cancel-deletion',
    tags: ['billing'],
    summary: 'Cancel a pending account deletion',
    ...auth,
    responses: { 200: json(ResultSchema, 'Cancellation result') },
  }),
  async (c: Context<AppEnv>) => {
    const userId = c.get('userId') as string;
    if (await cancelPersonDeletion(userId)) {
      return c.json({ success: true, message: 'Account deletion cancelled' });
    }
    // A legacy request on the personal account; throws 400 when there is none.
    return c.json(await cancelAccountDeletion(userId));
  },
);

accountDeletionRouter.openapi(
  createRoute({
    method: 'delete',
    path: '/delete-immediately',
    tags: ['billing'],
    summary: 'Delete your account immediately',
    description:
      'Deletes the workspaces you own alone, removes you from the others, and deletes your login, in that order. 409 `sole_owner_of_shared_workspace` (with the list) while you are the only owner of a workspace other people use; nothing is deleted then.',
    ...auth,
    responses: {
      200: json(ResultSchema, 'Immediate deletion result'),
      403: json(ResultSchema, 'Not a person acting for themselves'),
      409: json(ResultSchema, 'Sole owner of a shared workspace'),
    },
  }),
  async (c: Context<AppEnv>) => {
    const denial = personDenial(c);
    if (denial) return c.json(denial, 403);
    try {
      const { plan } = await deletePerson(c.get('userId') as string, 'now');
      return c.json({ success: true, message: 'Account deleted', ...planBody(plan) });
    } catch (error) {
      if (error instanceof SoleOwnerOfSharedWorkspaceError) return c.json(soleOwnerBody(error), 409);
      throw error;
    }
  },
);
