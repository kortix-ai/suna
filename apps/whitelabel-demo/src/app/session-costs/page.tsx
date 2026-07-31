'use client';

import { BrandMark } from '@/components/brand-mark';
import { CallSnippet } from '@/components/dev/call-snippet';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { getSessionToken } from '@/lib/session';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Receipt } from 'lucide-react';
import Link from 'next/link';
import { useWrapperMode } from '../providers';
import type { SessionCostsResponse } from './contract';

async function fetchSessionCosts(): Promise<SessionCostsResponse> {
  const token = getSessionToken();
  const response = await fetch('/api/session-costs', {
    headers: token ? { authorization: `Bearer ${token}` } : undefined,
  });
  if (!response.ok) {
    throw new Error(`session cost request failed (${response.status})`);
  }
  return response.json();
}

function usd(value: number | undefined): string {
  return `$${(value ?? 0).toFixed(4)}`;
}

export default function SessionCostsPage() {
  const wrapperMode = useWrapperMode();
  if (!wrapperMode) return <NotInDirectMode />;
  return <SessionCostsDashboard />;
}

function NotInDirectMode() {
  return (
    <div className="grid min-h-dvh place-items-center bg-background px-4">
      <Card className="w-full max-w-sm p-6 text-center">
        <BrandMark className="mx-auto mb-4" />
        <h1 className="text-lg font-semibold tracking-tight">
          Wrapper mode only
        </h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          This view uses the wrapper&apos;s project ownership records to select
          sessions.
        </p>
        <Button asChild className="mt-5 gap-2">
          <Link href="/">
            <ArrowLeft className="size-4" /> Back to projects
          </Link>
        </Button>
      </Card>
    </div>
  );
}

function SessionCostsDashboard() {
  const costs = useQuery({
    queryKey: ['session-costs'],
    queryFn: fetchSessionCosts,
  });
  const data = costs.data;

  return (
    <div className="min-h-dvh bg-background">
      <header className="sticky top-0 z-10 border-b border-border bg-background/80 backdrop-blur">
        <div className="mx-auto flex max-w-4xl items-center px-5 py-3">
          <Link
            href="/"
            className="inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="size-4" /> Back to projects
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-5 py-8">
        <div className="flex items-center gap-2">
          <Receipt className="size-5 text-muted-foreground" />
          <h1 className="text-xl font-semibold tracking-tight">
            Session costs
          </h1>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Each row represents one Kortix session. The wrapper applies its
          configured markup to that session&apos;s recorded cost.
        </p>

        {costs.isLoading && (
          <div className="mt-6 space-y-3">
            <Skeleton className="h-20 rounded-xl" />
            <Skeleton className="h-40 rounded-xl" />
          </div>
        )}

        {costs.isError && (
          <Card className="mt-6 p-6 text-sm text-destructive">
            Session costs could not be loaded. Sign in again and retry.
          </Card>
        )}

        {data && (
          <>
            <div className="mt-6 grid grid-cols-2 gap-3">
              <Card className="p-4">
                <div className="text-xs text-muted-foreground">
                  Raw Kortix cost
                </div>
                <div className="mt-1 text-2xl font-semibold tracking-tight tabular-nums">
                  {usd(data.totals.raw)}
                </div>
              </Card>
              <Card className="border-brand/30 p-4">
                <div className="text-xs text-muted-foreground">
                  Wrapper price ({data.markup}×)
                </div>
                <div className="mt-1 text-2xl font-semibold tracking-tight tabular-nums">
                  {usd(data.totals.billed)}
                </div>
              </Card>
            </div>

            <div className="mt-8">
              <CallSnippet
                id="session.costs"
                context={{ projectId: data.projects[0]?.projectId }}
              />
            </div>

            {data.projects.length === 0 && (
              <Card className="mt-3 p-8 text-center text-sm text-muted-foreground">
                No projects are available. Session costs appear after a session
                records usage.
              </Card>
            )}

            {data.projects.map((project) => (
              <Card
                key={project.projectId}
                className="mt-4 overflow-hidden p-0"
              >
                <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2.5">
                  <span className="truncate font-mono text-xs text-muted-foreground">
                    {project.projectId}
                  </span>
                  <Badge variant="secondary" className="shrink-0">
                    {project.sessions.length} session
                    {project.sessions.length === 1 ? '' : 's'}
                  </Badge>
                </div>
                {project.error ? (
                  <p className="px-4 py-4 text-xs text-destructive">
                    {project.error}
                  </p>
                ) : project.sessions.length === 0 ? (
                  <p className="px-4 py-4 text-xs text-muted-foreground">
                    No sessions yet.
                  </p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm">
                      <thead>
                        <tr className="text-xs text-muted-foreground">
                          <th className="px-4 py-2 font-medium">Session</th>
                          <th className="px-4 py-2 font-medium">LLM cost</th>
                          <th className="px-4 py-2 font-medium">
                            Compute cost
                          </th>
                          <th className="px-4 py-2 font-medium">Raw total</th>
                          <th className="px-4 py-2 font-medium">
                            Wrapper price
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {project.sessions.map((sessionCost) => (
                          <tr key={sessionCost.session_id}>
                            <td className="max-w-[10rem] truncate px-4 py-2 font-mono text-xs">
                              {sessionCost.session_id}
                            </td>
                            <td className="px-4 py-2 text-xs tabular-nums">
                              {usd(sessionCost.llm_cost)}
                            </td>
                            <td className="px-4 py-2 text-xs tabular-nums">
                              {usd(sessionCost.compute_cost)}
                            </td>
                            <td className="px-4 py-2 text-xs tabular-nums">
                              {usd(sessionCost.total_cost)}
                            </td>
                            <td className="px-4 py-2 text-xs font-medium text-foreground tabular-nums">
                              {usd(sessionCost.billed_cost)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>
            ))}
          </>
        )}
      </main>
    </div>
  );
}
