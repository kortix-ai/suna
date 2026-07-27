/**
 * Cost pass-through: aggregate `GET {upstream}/projects/:id/gateway/sessions`
 * across every project the caller owns (via the SDK's
 * `kortix.project(id).gateway.sessions()`), apply `COST_MARKUP`, and return
 * both the raw Kortix cost and the marked-up "your price" per session — the
 * re-billing surface a real wrapper would show its own users. Rendered by
 * `src/app/usage/page.tsx`. `createScopedKortix` (`@kortix/sdk/server`) is
 * used instead of the shared `configureKortix()` singleton because this route
 * serves concurrent requests carrying different end users' identities on one
 * process — each call gets its own isolated config via `AsyncLocalStorage`.
 */

import type { GatewaySessionStat } from '@kortix/sdk';
import { createScopedKortix } from '@kortix/sdk/server';
import { splitEndUserBills } from '@/server/end-user-billing';
import { getRequestSession } from '@/server/auth';
import { consumeRateLimit } from '@/server/rate-limit';
import { isValidProjectId, listOwnedProjects } from '@/server/users';
import type { NextRequest } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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
        const message = err instanceof Error ? err.message : 'request failed';
        return { projectId, sessions: [], error: message };
      }
    }),
  );

  // Kortix-as-a-Backend: upstream bills this account ONCE. end_user_ref — which
  // the /api/kortix proxy stamps from the signed-in session — is what splits
  // that bill back out per Lumen user, which is the whole point of running as a
  // wrapper. Best-effort: an upstream that cannot group this way must not take
  // the rest of the page down with it.
  // NARROWED TO THE CALLER. The account-wide rollup is exactly that —
  // account-wide — so returning it unfiltered would let any signed-in Lumen user
  // read every OTHER end-user's id and spend from the main nav. `projects` above
  // is already scoped to owned projects; this has to be scoped too.
  //
  // A real operator dashboard would gate the unnarrowed view behind an operator
  // role. The demo has no such role, so it shows you your own line only.
  const endUserBills = await kortix.billing
    .usageRollup({ groupBy: 'end_user_ref', endUserRef: session.userId })
    .then((rollup) => splitEndUserBills(rollup.breakdown, markup))
    .catch(() => ({ bills: [], unattributedCost: 0 }));

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

  return Response.json({
    markup,
    totals: { raw: round2(totals.raw), billed: round2(totals.billed) },
    by_end_user: endUserBills.bills,
    unattributed_cost: endUserBills.unattributedCost,
    projects,
  });
}
