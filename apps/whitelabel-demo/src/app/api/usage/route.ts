/**
 * `/api/usage` — the metering and guardrail surface for wrapper mode.
 *
 * GET aggregates two different things and keeps them visibly separate:
 *  - `GET {upstream}/projects/:id/gateway/sessions` across every project the
 *    caller owns, marked up by `COST_MARKUP` — the per-session re-billing view.
 *  - `GET {upstream}/usage` — the ACCOUNT's own metering, read three ways:
 *    ungrouped (the account total), `?group_by=end_user_ref` (the per-end-user
 *    split), and `?end_user_ref=<me>` (this end-user's own line). All three are
 *    reported with their own error slot, because "couldn't read it" and "zero"
 *    look identical once they collapse into one number and only one of them
 *    means the money is accounted for.
 *
 * POST runs the two guardrail PROBES the founder otherwise has to reach for
 * curl to see: a caps probe (one session create, reporting whichever 429 code
 * came back) and an idempotency probe (two creates under one key, reporting
 * whether the same session came back or a 409 did).
 *
 * These calls go to upstream DIRECTLY rather than through `/api/kortix` — this
 * route is server-side aggregation, so `src/server/policy.ts` (which gates what
 * a BROWSER may address) is not on the path and needs no `/usage` entry. The
 * ownership check the policy would have applied is re-asserted here by hand
 * before any project id reaches an upstream URL.
 *
 * `createScopedKortix` (`@kortix/sdk/server`) is used instead of the shared
 * `configureKortix()` singleton because this route serves concurrent requests
 * carrying different end users' identities on one process — each call gets its
 * own isolated config via `AsyncLocalStorage`.
 */

import type { GatewaySessionStat, UsageRollup } from '@kortix/sdk';
import { createScopedKortix, forwardKortixRequest } from '@kortix/sdk/server';
import { splitEndUserBills } from '@/server/end-user-billing';
import { getRequestSession } from '@/server/auth';
import { consumeRateLimit } from '@/server/rate-limit';
import { isValidProjectId, isOwner, listOwnedProjects } from '@/server/users';
import {
  classifyCapProbe,
  classifyIdempotencyProbe,
  type IdempotencyVariant,
  type ProbeAttempt,
  type ProbeResponse,
  type UsageMoney,
  type UsageResponse,
} from '@/app/usage/contract';
import { randomUUID } from 'node:crypto';
import type { NextRequest } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Who may read the ACCOUNT-wide rollups (the total, and every end-user's row).
 *
 * The grouped breakdown names other end-users and prices them, so returning it
 * unconditionally would let any signed-in Lumen user read every other one's id
 * and spend from the main nav. A real product gates that behind an operator
 * role; the demo has no role model, so it takes an explicit allowlist and
 * defaults to nobody. `*` opts every signed-in user in — fine for a founder
 * poking at a demo, never for a deployment with real users on it.
 */
const ACCOUNT_VIEW_ENV_VAR = 'LUMEN_USAGE_SHOW_ACCOUNT_BREAKDOWN';

/**
 * Whether THIS DEPLOYMENT exposes the account-wide breakdown.
 *
 * Deliberately NOT a per-user check. The first cut allowlisted operator emails,
 * which reads like authorization and is not: this demo's login accepts ANY
 * email with any password (`checkDemoCredentials`), so `session.userId` is an
 * unverified string the visitor typed. Anyone who wanted the breakdown could
 * simply sign in as an allowlisted address — the allowlist named a user without
 * ever authenticating one.
 *
 * A deployment-level switch is the honest shape of the actual statement: "this
 * instance is a single-tenant demo, so showing every end-user's spend harms
 * nobody." It cannot be bypassed by choosing a different email, because it does
 * not consult identity at all. A real product would gate this on a role, which
 * requires a real user directory — which this demo intentionally does not have.
 *
 * Default OFF: the breakdown names other end-users and prices them.
 */
function accountBreakdownEnabled(): boolean {
  const raw = (process.env[ACCOUNT_VIEW_ENV_VAR] ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

function upstreamBase(): string {
  return (process.env.KORTIX_UPSTREAM ?? 'https://api.kortix.com/v1').replace(/\/+$/, '');
}

function markupMultiplier(): number {
  const n = Number(process.env.COST_MARKUP ?? 1.2);
  return Number.isFinite(n) && n > 0 ? n : 1.2;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : 'request failed';
}

function toMoney(rollup: UsageRollup, markup: number): UsageMoney {
  const raw = rollup.data?.total_cost ?? 0;
  return { rawCost: round2(raw), billedCost: round2(raw * markup), sessions: rollup.data?.count ?? 0 };
}

/** Resolve a promise into a `[value, error]` pair — one upstream read failing
 *  must never take the other two down with it, and must never look like zero. */
async function settle<T>(work: Promise<T>): Promise<[T | null, string | null]> {
  try {
    return [await work, null];
  } catch (err) {
    return [null, errorText(err)];
  }
}

export async function GET(req: NextRequest) {
  const apiKey = process.env.KORTIX_API_KEY;
  if (!apiKey) {
    return Response.json({ error: 'Wrapper mode is not enabled on this server.' }, { status: 500 });
  }

  const session = getRequestSession(req);
  if (!session) return Response.json({ error: 'Not authenticated' }, { status: 401 });

  const limited = consumeRateLimit(session.userId);
  if (!limited.ok) return Response.json({ error: 'Rate limit exceeded' }, { status: 429 });

  const markup = markupMultiplier();
  const upstream = upstreamBase();
  const operator = accountBreakdownEnabled();
  // listOwnedProjects already UUID-filters, but re-assert at the call site:
  // these ids come from a file and are interpolated into upstream URLs.
  const projectIds = listOwnedProjects(session.userId).filter(isValidProjectId);

  const kortix = createScopedKortix({ backendUrl: upstream, getToken: async () => apiKey });

  const projects = await Promise.all(
    projectIds.map(async (projectId) => {
      // Explicit per-item barrier right before the call — the list is already
      // UUID-filtered above, but static analysis needs the guard on the same
      // control path as the request.
      if (!isValidProjectId(projectId)) {
        return { projectId, sessions: [], error: 'invalid project id' };
      }
      try {
        const data = await kortix.project(projectId).gateway.sessions();
        const sessions: GatewaySessionStat[] = Array.isArray(data?.sessions) ? data.sessions : [];
        return {
          projectId,
          sessions: sessions.map((s) => ({
            ...s,
            billed_cost: round2((s.total_cost ?? 0) * markup),
          })),
        };
      } catch (err) {
        return { projectId, sessions: [], error: errorText(err) };
      }
    }),
  );

  // Kortix-as-a-Backend: upstream bills this account ONCE. `end_user_ref` — which
  // the /api/kortix proxy stamps from the signed-in session — is what splits that
  // bill back out per Lumen user, which is the whole point of running as a
  // wrapper.
  //
  // The grouped read is narrowed to the caller unless they're an operator (see
  // accountBreakdownEnabled). `mine` is always narrowed and is the same query a wrapper would
  // run to answer "what does this customer owe me".
  const [grouped, groupedError] = await settle(
    kortix.billing.usageRollup(
      operator
        ? { groupBy: 'end_user_ref' }
        : { groupBy: 'end_user_ref', endUserRef: session.userId },
    ),
  );
  const [mineRollup, mineError] = await settle(
    kortix.billing.usageRollup({ endUserRef: session.userId }),
  );
  // Ungrouped and un-narrowed: the number the per-end-user rows are supposed to
  // NOT add up to. Without it the caveat below is a claim rather than arithmetic.
  const [accountRollup, accountTotalError] = operator
    ? await settle(kortix.billing.usageRollup({}))
    : [null, null];

  const endUserBills = splitEndUserBills(grouped?.breakdown, markup);
  const attributedRaw = endUserBills.bills.reduce((sum, bill) => sum + bill.rawCost, 0);
  const accountTotal = accountRollup ? toMoney(accountRollup, markup) : null;

  const totals = projects.reduce(
    (acc, p) => {
      for (const s of p.sessions) {
        acc.raw += s.total_cost ?? 0;
        acc.billed += s.billed_cost ?? 0;
      }
      return acc;
    },
    { raw: 0, billed: 0 },
  );

  // Annotated so the wire shape and the view's contract cannot drift apart —
  // a silently-dropped field here reads as "$0.00" in the browser.
  const payload: UsageResponse = {
    markup,
    endUserRef: session.userId,
    operator,
    scope: operator ? 'account' : 'self',
    totals: { raw: round2(totals.raw), billed: round2(totals.billed) },
    projects,
    mine: mineRollup ? toMoney(mineRollup, markup) : null,
    mineError,
    by_end_user: endUserBills.bills,
    groupedError,
    accountTotal,
    accountTotalError,
    // NULL-ref spend (dashboard sessions, anything predating the field) is
    // excluded from the grouping but still in the total, so this is the gap —
    // and `null` means "not computable", never "nothing missing".
    unattributed_cost: accountTotal
      ? round2(Math.max(0, accountTotal.rawCost - attributedRaw) + endUserBills.unattributedCost)
      : null,
    operatorEnvVar: ACCOUNT_VIEW_ENV_VAR,
  };
  return Response.json(payload);
}

// ── Probes ───────────────────────────────────────────────────────────────────

/**
 * One session create, straight to upstream, reported verbatim.
 *
 * `end_user_ref` is stamped HERE from the verified session — same rule as the
 * proxy, for the same reason: a client that could choose it could bill another
 * user, or replay their session through a shared key. `forwardKortixRequest`
 * substitutes the wrapper's API key for Authorization, so the browser's own
 * token never reaches Kortix.
 */
async function attemptCreate(opts: {
  apiKey: string;
  projectId: string;
  label: string;
  body: Record<string, unknown>;
  idempotencyKey: string | null;
}): Promise<ProbeAttempt> {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (opts.idempotencyKey) headers.set('idempotency-key', opts.idempotencyKey);

  const url = `${upstreamBase()}/projects/${opts.projectId}/sessions`;
  const response = await forwardKortixRequest({
    request: new Request(url, { method: 'POST', headers, body: JSON.stringify(opts.body) }),
    upstreamUrl: url,
    token: opts.apiKey,
  });

  let parsed: Record<string, unknown> = {};
  try {
    const text = await response.text();
    const json: unknown = text ? JSON.parse(text) : null;
    if (json && typeof json === 'object' && !Array.isArray(json)) {
      parsed = json as Record<string, unknown>;
    }
  } catch {
    // A non-JSON upstream reply still has a status, and the status is most of
    // the story — keep it rather than turning the whole probe into an error.
  }

  return {
    label: opts.label,
    status: response.status,
    code: typeof parsed.code === 'string' ? parsed.code : null,
    message: typeof parsed.error === 'string' ? parsed.error : null,
    sessionId: typeof parsed.session_id === 'string' ? parsed.session_id : null,
    idempotencyKey: opts.idempotencyKey,
    sentBody: opts.body,
  };
}

export async function POST(req: NextRequest) {
  const apiKey = process.env.KORTIX_API_KEY;
  if (!apiKey) {
    return Response.json({ error: 'Wrapper mode is not enabled on this server.' }, { status: 500 });
  }

  const session = getRequestSession(req);
  if (!session) return Response.json({ error: 'Not authenticated' }, { status: 401 });

  const limited = consumeRateLimit(session.userId);
  if (!limited.ok) return Response.json({ error: 'Rate limit exceeded' }, { status: 429 });

  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = await req.json();
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      body = parsed as Record<string, unknown>;
    }
  } catch {
    body = {};
  }

  const probe = body.probe === 'idempotency' ? 'idempotency' : body.probe === 'caps' ? 'caps' : null;
  if (!probe) {
    return Response.json({ error: 'probe must be "caps" or "idempotency"' }, { status: 400 });
  }

  const projectId = typeof body.projectId === 'string' ? body.projectId : '';
  // The same ownership gate `evaluatePolicy` applies to `projects/{id}/...`
  // through the proxy. This route bypasses the proxy, so it cannot inherit it.
  if (!isValidProjectId(projectId) || !isOwner(session.userId, projectId)) {
    return Response.json({ error: "You don't have access to this project." }, { status: 403 });
  }

  const endUserRef = session.userId;

  if (probe === 'caps') {
    const attempt = await attemptCreate({
      apiKey,
      projectId,
      label: 'session create',
      body: { end_user_ref: endUserRef },
      idempotencyKey: null,
    });
    const result: ProbeResponse = {
      probe,
      endUserRef,
      attempts: [attempt],
      verdict: classifyCapProbe(attempt),
    };
    return Response.json(result);
  }

  const variant: IdempotencyVariant = body.variant === 'conflict' ? 'conflict' : 'replay';
  // One key, generated here and reused across both attempts — a client-chosen
  // key is exactly the thing an end-user must not be able to aim at somebody
  // else's session.
  const key = `lumen-probe-${randomUUID()}`;
  const firstBody = { end_user_ref: endUserRef, runtime_context: { lumen_probe: 'first' } };
  // `runtime_context` is the smallest field that differs without needing a real
  // secret or connector to exist, so the conflict variant works on any project.
  const secondBody =
    variant === 'conflict'
      ? { end_user_ref: endUserRef, runtime_context: { lumen_probe: 'second' } }
      : firstBody;

  const first = await attemptCreate({
    apiKey,
    projectId,
    label: 'first create',
    body: firstBody,
    idempotencyKey: key,
  });
  const second = await attemptCreate({
    apiKey,
    projectId,
    label: variant === 'conflict' ? 'replay with a DIFFERENT body' : 'replay with the SAME body',
    body: secondBody,
    idempotencyKey: key,
  });

  const result: ProbeResponse = {
    probe,
    endUserRef,
    attempts: [first, second],
    verdict: classifyIdempotencyProbe(first, second),
  };
  return Response.json(result);
}
