// Shared request helpers for the IAM V2 route modules: body parsing, the
// context-bound audit writer, the Postgres unique-violation classifier, and
// the compact HttpError used by the policy-parser short-circuits.

import { Context } from 'hono';
import { recordAuditEvent } from '../../shared/audit';
import { accountHasEntitlement } from '../../billing/services/entitlements';
import type { TierEntitlements } from '../../types';

/** Human label per entitlement, for the 402 message shown to admins. */
const ENTITLEMENT_LABEL: Record<keyof TierEntitlements, string> = {
  sso: 'SAML single sign-on',
  scim: 'SCIM directory provisioning',
  rbac: 'Custom roles, policies, and groups',
  auditAccess: 'Audit log access and export',
};

/**
 * Gate an enterprise-only IAM surface behind the account's plan. Returns a 402
 * `Response` to return early when the account's tier lacks `key`, or `null`
 * when entitled. Enterprise features (SSO, SCIM) are sales-assigned via the
 * `enterprise` tier — everyone else gets a "contact sales" 402 rather than a
 * silent 403, so the UI can surface an upgrade path.
 *
 *   const denied = await requireEntitlement(c, accountId, 'sso');
 *   if (denied) return denied;
 */
export async function requireEntitlement(
  c: Context,
  accountId: string,
  key: keyof TierEntitlements,
): Promise<Response | null> {
  if (await accountHasEntitlement(accountId, key)) return null;
  return c.json(
    {
      error: `${ENTITLEMENT_LABEL[key]} is available on the Enterprise plan. Contact sales to enable it.`,
      code: 'entitlement_required',
      entitlement: key,
    },
    402,
  );
}

export async function readBody(c: Context): Promise<Record<string, unknown>> {
  try {
    return (await c.req.json()) ?? {};
  } catch {
    return {};
  }
}

/**
 * Audit helper bound to the request context. The global middleware already
 * logs a coarse "POST /v1/accounts/.../iam/groups" row for every state
 * change; these explicit calls add the before/after detail that makes "who
 * changed X for Y on Z date" a single audit_events query.
 */
export async function auditIam(
  c: Context,
  args: {
    accountId: string;
    action: string;
    resourceType: string;
    resourceId?: string | null;
    before?: Record<string, unknown> | null;
    after?: Record<string, unknown> | null;
  },
) {
  try {
    await recordAuditEvent({
      accountId: args.accountId,
      actorUserId: c.get('userId') as string | undefined,
      action: args.action,
      resourceType: args.resourceType,
      resourceId: args.resourceId ?? null,
      before: args.before ?? null,
      after: args.after ?? null,
      ip:
        c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
        c.req.header('x-real-ip') ||
        null,
      userAgent: c.req.header('user-agent') || null,
    });
  } catch (err) {
    // Audit failures must not break the mutation that succeeded. Log loudly
    // so it surfaces in monitoring; downgrade to console.warn if we end up
    // alerting on console.error.
    console.error('[iam audit] failed to write audit event', args.action, err);
  }
}

/**
 * Drizzle wraps the raw postgres-js error inside DrizzleQueryError as `cause`.
 * The wrapper's `message` is the formatted "Failed query: …" string, which
 * never matches "unique"/"duplicate" — we have to drill into the cause and
 * check the Postgres SQLSTATE. 23505 = unique_violation.
 */
export function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const cause = (err as { cause?: { code?: string } }).cause;
  if (cause && cause.code === '23505') return true;
  // Belt-and-braces: some adapters surface the code on the top-level error.
  if ((err as { code?: string }).code === '23505') return true;
  return false;
}

// Compact local error so the policy-parser helpers can short-circuit.
export class HttpError extends Error {
  constructor(public status: 400 | 404 | 409 | 422, message: string) {
    super(message);
  }
}
