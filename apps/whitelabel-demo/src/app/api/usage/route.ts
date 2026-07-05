/**
 * Cost pass-through: aggregate `GET {upstream}/projects/:id/gateway/sessions`
 * across every project the caller owns, apply `COST_MARKUP`, and return both
 * the raw Kortix cost and the marked-up "your price" per session — the
 * re-billing surface a real wrapper would show its own users. Rendered by
 * `src/app/usage/page.tsx`.
 */

import { getRequestSession } from '@/server/auth';
import { consumeRateLimit } from '@/server/rate-limit';
import { listOwnedProjects } from '@/server/users';
import type { NextRequest } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface GatewaySessionStat {
  session_id: string;
  llm_cost?: number;
  compute_cost?: number;
  tokens?: number;
  compute_seconds?: number;
  total_cost?: number;
  [key: string]: unknown;
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
  const projectIds = listOwnedProjects(session.userId);

  const projects = await Promise.all(
    projectIds.map(async (projectId) => {
      try {
        const res = await fetch(`${upstream}/projects/${encodeURIComponent(projectId)}/gateway/sessions`, {
          headers: { authorization: `Bearer ${apiKey}` },
        });
        if (!res.ok) return { projectId, sessions: [], error: `upstream responded ${res.status}` };
        const data = await res.json();
        const sessions: GatewaySessionStat[] = Array.isArray(data?.sessions) ? data.sessions : [];
        return {
          projectId,
          sessions: sessions.map((s) => ({
            ...s,
            billed_cost: round2((s.total_cost ?? 0) * markup),
          })),
        };
      } catch {
        return { projectId, sessions: [], error: 'request failed' };
      }
    }),
  );

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
    projects,
  });
}
