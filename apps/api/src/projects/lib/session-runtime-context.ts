import { type SessionRuntimeContext, SessionRuntimeContextSchema } from '@kortix/api-contract';
import { projectSessionRuntimeContexts } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { db } from '../../shared/db';

/** The only environment variable a public runtime_context request can create. */
export const SESSION_RUNTIME_CONTEXT_ENV_NAME = 'KORTIX_SESSION_CONTEXT';

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

export function serializeSessionRuntimeContext(context: SessionRuntimeContext): string {
  // Parse again at the persistence/runtime boundary so an internal TypeScript
  // cast cannot bypass the public contract and smuggle nested data or secrets.
  return JSON.stringify(SessionRuntimeContextSchema.parse(context));
}

export async function persistSessionRuntimeContext(
  sessionId: string,
  context: SessionRuntimeContext,
): Promise<void> {
  const serialized = serializeSessionRuntimeContext(context);
  await db
    .insert(projectSessionRuntimeContexts)
    .values({
      sessionId,
      context,
      byteSize: new TextEncoder().encode(serialized).byteLength,
      updatedAt: new Date(),
    })
    .returning({ sessionId: projectSessionRuntimeContexts.sessionId });
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
  if (base[SESSION_RUNTIME_CONTEXT_ENV_NAME] !== undefined) {
    merged[SESSION_RUNTIME_CONTEXT_ENV_NAME] = base[SESSION_RUNTIME_CONTEXT_ENV_NAME];
  } else {
    delete merged[SESSION_RUNTIME_CONTEXT_ENV_NAME];
  }
  return merged;
}
