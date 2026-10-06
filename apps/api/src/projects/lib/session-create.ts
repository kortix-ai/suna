import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { setContextField } from '../../lib/request-context';
import {
  TITLE_SOURCE_MAX_CHARS,
  generateSessionTitleFromFirstPrompt,
  titleSourceForCreate,
} from '../session-title-generate';
import type { ProjectSessionRow } from './serializers';
import {
  type SessionCreateInput,
  type SessionCreatePlan,
  buildSessionCreateIdentity,
  checkSessionCreateBilling,
  enforceSessionDeclaredAgents,
  resolveSessionCreateAgent,
  resolveSessionCreateConnectors,
  resolveSessionCreateInheritance,
  resolveSessionCreateModel,
  resolveSessionCreateSandbox,
} from './session-create-plan';
import { insertSessionAndBindings } from './session-create-launch';
import { provisionCreatedSession } from './session-create-provision';

export { type SessionCreateInput, resolveSessionAgentName } from './session-create-plan';

/** Every status a failed create answers with. Routes that create a session
 *  declare these, so the published spec lists them. */
export const SESSION_CREATE_ERROR_STATUSES = [400, 402, 403, 404, 409, 429, 500, 503] as const;
export type SessionCreateErrorStatus = (typeof SESSION_CREATE_ERROR_STATUSES)[number];

/** A status from an HTTPException thrown inside the create, narrowed to the
 *  declared set. Nothing in the insert throws one outside it today; an
 *  undeclared 4xx would answer 400 rather than a status the spec omits. */
function sessionCreateErrorStatus(status: number): SessionCreateErrorStatus {
  return (SESSION_CREATE_ERROR_STATUSES as readonly number[]).includes(status)
    ? (status as SessionCreateErrorStatus)
    : 400;
}

export type SessionCreateError = {
  status: SessionCreateErrorStatus;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
};

export function sendSessionCreateError(c: Context, error: SessionCreateError) {
  for (const [key, value] of Object.entries(error.headers ?? {})) c.header(key, value);
  return c.json(error.body, error.status);
}

/** The fields postgres.js attaches to a `Failed query:` error (pg error codes). */
type PostgresErrorFields = {
  code?: string;
  constraint?: string;
  detail?: string;
  table?: string;
  column?: string;
  message?: string;
};

/**
 * Map a failure of the session-insert transaction to an HTTP error body.
 *
 * A postgres.js error's `message` embeds the FULL SQL statement and EVERY bound
 * parameter value (attachment filenames, model config, opaque ids). Returning
 * that message to the client leaked customer data into the caller's error
 * tracker as an opaque `ApiError` (Better Stack pattern `9aecd4f8…`) and hid the
 * cause, which the old `catch` never logged. Log the real cause server-side
 * here, and return a stable, non-leaking body the caller can branch on.
 *
 * A `23505` unique violation on the session PK means the caller retried a
 * create with a `session_id` that already exists; that is an idempotent race,
 * not a defect, so it maps to a typed 409.
 */
export function resolveSessionInsertFailure(error: unknown): SessionCreateError {
  const pg = (error ?? {}) as PostgresErrorFields;
  // postgres.js appends the bound parameter values after "\nparams:" in the
  // message. Keep the statement (column names only) and drop the values, so the
  // server log identifies the failing insert without duplicating customer data.
  const message = (pg.message ?? String(error)).split('\nparams:')[0];
  console.error('[projects] session insert failed', {
    pgCode: pg.code ?? null,
    constraint: pg.constraint ?? null,
    table: pg.table ?? null,
    column: pg.column ?? null,
    detail: pg.detail ?? null,
    message,
  });
  if (pg.code === '23505') {
    return {
      status: 409,
      body: { error: 'A session with this id already exists', code: 'session_already_exists' },
    };
  }
  return {
    status: 500,
    body: { error: 'Failed to create session', code: 'SESSION_CREATE_FAILED', retry: true },
  };
}

export async function createProjectSession(input: SessionCreateInput): Promise<{
  row?: ProjectSessionRow;
  error?: SessionCreateError;
  pendingPromptIdempotencyKey?: string | null;
}> {
  const project = input.project;
  const body = input.body;

  const inheritance = await resolveSessionCreateInheritance(input);
  if (!inheritance.ok) return { error: inheritance.error };
  const agent = await resolveSessionCreateAgent(input);
  if (!agent.ok) return { error: agent.error };
  const model = await resolveSessionCreateModel(input, inheritance.value, agent.value);
  if (!model.ok) return { error: model.error };
  const connectors = await resolveSessionCreateConnectors(input, inheritance.value, agent.value);
  if (!connectors.ok) return { error: connectors.error };
  const declaredAgents = enforceSessionDeclaredAgents(input, agent.value);
  if (!declaredAgents.ok) return { error: declaredAgents.error };
  const sandbox = await resolveSessionCreateSandbox(input, agent.value);
  if (!sandbox.ok) return { error: sandbox.error };
  const billing = await checkSessionCreateBilling(input);
  if (!billing.ok) return { error: billing.error };
  const identity = buildSessionCreateIdentity(input, {
    ...inheritance.value,
    ...agent.value,
    ...model.value,
    ...connectors.value,
    ...sandbox.value,
  });
  if (!identity.ok) return { error: identity.error };

  const plan: SessionCreatePlan = {
    accountId: project.accountId,
    projectId: project.projectId,
    userId: input.userId,
    ...inheritance.value,
    ...agent.value,
    ...model.value,
    ...connectors.value,
    ...sandbox.value,
    ...identity.value,
    runtimeContext: inheritance.value.parsedRuntimeContext.context,
    connectorBindings: connectors.value.validatedConnectorBindings.bindings,
  };

  let sessionRow: ProjectSessionRow | null = null;
  try {
    sessionRow = await insertSessionAndBindings(input, plan);
  } catch (error) {
    // Besides a randomUUID() collision on the PK / (project_id, branch_name)
    // unique index, `sandbox_provider` is an ENUM: a provider this env enables
    // but the target DB's type is missing fails here with 22P02, not upstream —
    // resolveSessionProvider validates against config, never against the DB.
    // (That is how prod, whose faked baseline skipped 'platinum', 500'd every
    // create on a project pinned to it.) verify-live-schema.ts now gates that drift.
    // Session, context and connection bindings are one transaction. Nothing is
    // visible and provisioning never starts when any child insert fails.
    if (error instanceof HTTPException && error.status < 500) {
      return {
        error: { status: sessionCreateErrorStatus(error.status), body: await error.getResponse().json() },
      };
    }
    // Never return `(error as Error).message`: postgres.js embeds the whole
    // statement and its parameters in it (see `resolveSessionInsertFailure`).
    return { error: resolveSessionInsertFailure(error) };
  }

  const { sessionId, projectId, accountId, userId } = plan;

  if (sessionRow === null) {
    return {
      error: {
        status: 500,
        body: { error: 'Session insert returned no row', retry: true },
      },
    };
  }

  setContextField('sessionId', sessionId);

  // A prompt supplied at create is claimed by the session daemon. This is the
  // earliest title source. No modelHint: the row already carries `opencode_model`.
  const titleSource = titleSourceForCreate(body);
  if (titleSource) {
    void generateSessionTitleFromFirstPrompt({
      sessionId,
      projectId,
      accountId,
      userId,
      firstPromptText: titleSource,
    });
  }

  // Fire-and-forget sandbox provisioning. The dashboard polls the sandbox
  // status endpoint and shows the ConnectingScreen during the long tail.
  void provisionCreatedSession(project, input, plan);
  return {
    row: sessionRow,
    pendingPromptIdempotencyKey:
      plan.pendingPromptConversion?.rowValues?.idempotencyKey ?? null,
  };
}
