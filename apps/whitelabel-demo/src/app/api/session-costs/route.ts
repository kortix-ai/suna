import type { SessionCostSummary } from '@kortix/sdk';
import { createScopedKortix } from '@kortix/sdk/server';
import { getRequestSession } from '@/server/auth';
import { consumeRateLimit } from '@/server/rate-limit';
import { isValidWorkspaceId, listOwnedWorkspaces } from '@/server/users';
import type {
  SessionCostsResponse,
  SessionCostWorkspace,
} from '@/app/session-costs/contract';
import type { NextRequest } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function upstreamBase(): string {
  return (process.env.KORTIX_UPSTREAM ?? 'https://api.kortix.com/v1').replace(
    /\/+$/,
    '',
  );
}

function markupMultiplier(): number {
  const value = Number(process.env.COST_MARKUP ?? 1.2);
  return Number.isFinite(value) && value > 0 ? value : 1.2;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'request failed';
}

async function listWorkspaceSessionCosts(
  kortix: ReturnType<typeof createScopedKortix>,
  workspaceId: string,
): Promise<SessionCostSummary[]> {
  const sessions: SessionCostSummary[] = [];
  let offset: number | null = 0;

  while (offset !== null) {
    const page = await kortix.billing.sessionCosts.list({
      workspaceId,
      limit: 100,
      offset,
    });
    sessions.push(...page.sessions);
    offset = page.next_offset;
  }

  return sessions;
}

export async function GET(req: NextRequest) {
  const apiKey = process.env.KORTIX_API_KEY;
  if (!apiKey) {
    return Response.json(
      { error: 'Wrapper mode is not enabled on this server.' },
      { status: 500 },
    );
  }

  const session = getRequestSession(req);
  if (!session)
    return Response.json({ error: 'Not authenticated' }, { status: 401 });

  const limited = consumeRateLimit(session.userId);
  if (!limited.ok)
    return Response.json({ error: 'Rate limit exceeded' }, { status: 429 });

  const markup = markupMultiplier();
  const workspaceIds = listOwnedWorkspaces(session.userId).filter(isValidWorkspaceId);
  const kortix = createScopedKortix({
    backendUrl: upstreamBase(),
    getToken: async () => apiKey,
  });

  const workspaces: SessionCostWorkspace[] = await Promise.all(
    workspaceIds.map(async (workspaceId) => {
      try {
        const sessions = await listWorkspaceSessionCosts(kortix, workspaceId);
        return {
          workspaceId,
          sessions: sessions.map((sessionCost) => ({
            session_id: sessionCost.session_id,
            llm_cost: sessionCost.llm_cost,
            compute_cost: sessionCost.compute_cost,
            total_cost: sessionCost.total_cost,
            request_count: sessionCost.request_count,
            input_tokens: sessionCost.input_tokens,
            output_tokens: sessionCost.output_tokens,
            cached_tokens: sessionCost.cached_tokens,
            cache_write_tokens: sessionCost.cache_write_tokens,
            compute_seconds: sessionCost.compute_seconds,
            billed_cost: round2(sessionCost.total_cost * markup),
          })),
        };
      } catch (error) {
        return { workspaceId, sessions: [], error: errorText(error) };
      }
    }),
  );

  const totals = workspaces.reduce(
    (result, workspace) => {
      for (const sessionCost of workspace.sessions) {
        result.raw += sessionCost.total_cost;
        result.billed += sessionCost.billed_cost;
      }
      return result;
    },
    { raw: 0, billed: 0 },
  );

  const payload: SessionCostsResponse = {
    markup,
    totals: {
      raw: round2(totals.raw),
      billed: round2(totals.billed),
    },
    workspaces,
  };

  return Response.json(payload);
}
