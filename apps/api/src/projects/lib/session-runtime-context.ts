import { type SessionRuntimeContext, SessionRuntimeContextSchema } from '@kortix/api-contract';
import { projectSessionRuntimeContexts } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { db } from '../../shared/db';
import { SECRET_CAPABILITIES_ENV_NAME } from '../secret-capabilities';

/** The only environment variable a public runtime_context request can create. */
export const SESSION_RUNTIME_CONTEXT_ENV_NAME = 'KORTIX_SESSION_CONTEXT';

/**
 * Env vars the server owns end to end. A later `extraEnvVars` merge must not
 * forge or erase this durable context envelope.
 */
const SERVER_OWNED_ENV_NAMES = [
  SESSION_RUNTIME_CONTEXT_ENV_NAME,
  SECRET_CAPABILITIES_ENV_NAME,
] as const;

export function parseSessionRuntimeContext(
  value: unknown,
): { ok: true; context: SessionRuntimeContext | undefined } | { ok: false; error: string } {
  if (value === undefined) return { ok: true, context: undefined };
  const parsed = SessionRuntimeContextSchema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues.map((issue) => issue.message).join('; '),
    };
  }
  return { ok: true, context: parsed.data };
}

/**
 * The namespace the platform owns in a runtime_context. kortixd reads keys in
 * it as facts about the session: `kortix.subagent.depth` (no run approval
 * below depth 0), `kortix.subagent.tools` (the tool narrowing),
 * `kortix.agent.handle`, `kortix.team.lead`, `kortix.workflow.run_id` and
 * `kortix.workflow.handoff_sha256` (a workflow runner and the one hand-off it
 * runs). Only the box that creates its own child may set them: a create whose
 * credential is that box's session token, so the box becomes the child's
 * `spawned_by_session`.
 */
export const RESERVED_RUNTIME_CONTEXT_PREFIX = 'kortix.';

/** The reserved (`kortix.`) keys of a runtime_context, sorted. */
export function reservedRuntimeContextKeys(context: SessionRuntimeContext | undefined): string[] {
  return Object.keys(context ?? {})
    .filter((key) => key.startsWith(RESERVED_RUNTIME_CONTEXT_PREFIX))
    .sort();
}

/**
 * Why a create may not carry its runtime_context, or null. Reserved keys come
 * only from a session token creating its own child (`callerSessionId`, which
 * becomes the child's `spawned_by_session`); a person, an API key, a service
 * account or a project token may not declare them.
 */
export function reservedRuntimeContextRefusal(
  context: SessionRuntimeContext | undefined,
  callerSessionId: string | null | undefined,
): string | null {
  if (callerSessionId) return null;
  const reserved = reservedRuntimeContextKeys(context);
  if (reserved.length === 0) return null;
  return `runtime_context keys under "${RESERVED_RUNTIME_CONTEXT_PREFIX}" are reserved for the platform, and only a session creating its own child sets them: ${reserved.slice(0, 5).join(', ')}`;
}

export function serializeSessionRuntimeContext(context: SessionRuntimeContext): string {
  // Parse again at the persistence/runtime boundary so an internal TypeScript
  // cast cannot bypass the public contract and smuggle nested data or secrets.
  return JSON.stringify(SessionRuntimeContextSchema.parse(context));
}

export async function loadSessionRuntimeContext(
  sessionId: string,
): Promise<SessionRuntimeContext | null> {
  const [row] = await db
    .select({ context: projectSessionRuntimeContexts.context })
    .from(projectSessionRuntimeContexts)
    .where(eq(projectSessionRuntimeContexts.sessionId, sessionId))
    .limit(1);
  if (!row) return null;
  const parsed = SessionRuntimeContextSchema.safeParse(row.context);
  if (!parsed.success) {
    // Database constraints prove object/size, while this catches schema drift or
    // a manual write. Fail closed: malformed context never reaches a sandbox.
    console.warn('[session-context] ignored malformed persisted context', {
      sessionId,
      issues: parsed.error.issues.map((issue) => issue.message),
    });
    return null;
  }
  return parsed.data;
}

export async function buildSessionRuntimeContextEnv(
  sessionId: string,
): Promise<Record<string, string>> {
  const context = await loadSessionRuntimeContext(sessionId);
  return context
    ? { [SESSION_RUNTIME_CONTEXT_ENV_NAME]: serializeSessionRuntimeContext(context) }
    : {};
}

/**
 * Merge trusted internal extras without allowing them to replace the durable,
 * server-generated context envelope. There is intentionally no public raw-env
 * input; this is defense-in-depth for internal channel/trigger callers.
 */
export function mergeSessionSandboxEnv(
  base: Record<string, string>,
  extra?: Record<string, string>,
): Record<string, string> {
  if (!extra) return base;
  const merged = { ...base, ...extra };
  // Re-pin every server-owned var AFTER the spread: `extra` may legitimately add
  // provider/channel env, but it must never override the server's own identity
  // envelope. Absent in `base` means the server decided this session has none,
  // so a supplied value is deleted rather than honoured.
  for (const name of SERVER_OWNED_ENV_NAMES) {
    if (base[name] !== undefined) merged[name] = base[name];
    else delete merged[name];
  }
  return merged;
}
