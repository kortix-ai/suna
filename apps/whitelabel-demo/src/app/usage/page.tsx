'use client';

/**
 * The cost pass-through surface: per-project, per-session Kortix gateway
 * costs alongside the marked-up "your price" this wrapper would actually bill
 * its own users — backed by `GET /api/usage` (server-side aggregation over
 * every project the signed-in user owns; see `src/app/api/usage/route.ts`).
 *
 * Wrapper-mode only — direct mode has no per-user ownership model to scope
 * this to, so it gets the same short explainer pattern as `/account` in
 * wrapper mode.
 */

import { BrandMark } from '@/components/brand-mark';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { getSessionToken } from '@/lib/session';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Receipt } from 'lucide-react';
import Link from 'next/link';
import { useWrapperMode } from '../providers';

interface UsageSession {
  session_id: string;
  llm_cost?: number;
  compute_cost?: number;
  tokens?: number;
  compute_seconds?: number;
  total_cost?: number;
  billed_cost?: number;
}

interface UsageProject {
  projectId: string;
  sessions: UsageSession[];
  error?: string;
}

interface UsageResponse {
  markup: number;
  totals: { raw: number; billed: number };
  projects: UsageProject[];
}

async function fetchUsage(): Promise<UsageResponse> {
  const token = getSessionToken();
  const res = await fetch('/api/usage', {
    headers: token ? { authorization: `Bearer ${token}` } : undefined,
  });
  if (!res.ok) throw new Error(`usage request failed (${res.status})`);
  return res.json();
}

function usd(n: number | undefined): string {
  return `$${(n ?? 0).toFixed(4)}`;
}

export default function UsagePage() {
  const wrapperMode = useWrapperMode();
  if (!wrapperMode) return <NotInDirectMode />;
  return <UsageDashboard />;
}

function NotInDirectMode() {
  return (
    <div className="grid min-h-dvh place-items-center bg-background px-4">
      <Card className="w-full max-w-sm p-6 text-center">
        <BrandMark className="mx-auto mb-4" />
        <h1 className="text-lg font-semibold tracking-tight">Wrapper mode only</h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          Cost pass-through is scoped to per-user project ownership, which only exists when this
          app runs in wrapper mode (`KORTIX_API_KEY` set on the server).
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

function UsageDashboard() {
  const usage = useQuery({ queryKey: ['usage'], queryFn: fetchUsage });
  const data = usage.data;

  return (
    <div className="min-h-dvh bg-background">
      <header className="sticky top-0 z-10 border-b border-border bg-background/80 backdrop-blur">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-3 px-5 py-3">
          <Link
            href="/"
            className="inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="size-4" /> Back to projects
          </Link>
        </div>
      </header>

      <div className="mx-auto max-w-4xl px-5 py-8">
        <div className="flex items-center gap-2">
          <Receipt className="size-5 text-muted-foreground" />
          <h1 className="text-xl font-semibold tracking-tight">Usage &amp; billing</h1>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Raw Kortix gateway cost per session, and the marked-up price this wrapper would bill
          you{data ? ` (${data.markup}×)` : ''}. This is the re-billing surface — swap the numbers
          for your own pricing model.
        </p>

        {usage.isLoading && (
          <div className="mt-6 space-y-3">
            <Skeleton className="h-20 rounded-xl" />
            <Skeleton className="h-40 rounded-xl" />
          </div>
        )}

        {usage.isError && (
          <Card className="mt-6 p-6 text-sm text-destructive">
            Couldn&apos;t load usage — try signing in again.
          </Card>
        )}

        {data && (
          <>
            <div className="mt-6 grid grid-cols-2 gap-3">
              <Card className="p-4">
                <div className="text-xs text-muted-foreground">Raw Kortix cost</div>
                <div className="mt-1 text-2xl font-semibold tracking-tight">
                  {usd(data.totals.raw)}
                </div>
              </Card>
              <Card className="border-brand/30 p-4">
                <div className="text-xs text-muted-foreground">Your price ({data.markup}×)</div>
                <div className="mt-1 text-2xl font-semibold tracking-tight">
                  {usd(data.totals.billed)}
                </div>
              </Card>
            </div>

            {data.projects.length === 0 && (
              <Card className="mt-6 p-8 text-center text-sm text-muted-foreground">
                No projects yet — usage will show up here once you&apos;ve run a session.
              </Card>
            )}

            {data.projects.map((project) => (
              <Card key={project.projectId} className="mt-4 overflow-hidden p-0">
                <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2.5">
                  <span className="truncate font-mono text-xs text-muted-foreground">
                    {project.projectId}
                  </span>
                  <Badge variant="secondary" className="shrink-0">
                    {project.sessions.length} session{project.sessions.length === 1 ? '' : 's'}
                  </Badge>
                </div>
                {project.error ? (
                  <p className="px-4 py-4 text-xs text-destructive">{project.error}</p>
                ) : project.sessions.length === 0 ? (
                  <p className="px-4 py-4 text-xs text-muted-foreground">No sessions yet.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm">
                      <thead>
                        <tr className="text-xs text-muted-foreground">
                          <th className="px-4 py-2 font-medium">Session</th>
                          <th className="px-4 py-2 font-medium">LLM cost</th>
                          <th className="px-4 py-2 font-medium">Compute cost</th>
                          <th className="px-4 py-2 font-medium">Raw total</th>
                          <th className="px-4 py-2 font-medium">Your price</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {project.sessions.map((s) => (
                          <tr key={s.session_id}>
                            <td className="max-w-[10rem] truncate px-4 py-2 font-mono text-xs">
                              {s.session_id}
                            </td>
                            <td className="px-4 py-2 text-xs">{usd(s.llm_cost)}</td>
                            <td className="px-4 py-2 text-xs">{usd(s.compute_cost)}</td>
                            <td className="px-4 py-2 text-xs">{usd(s.total_cost)}</td>
                            <td className="px-4 py-2 text-xs font-medium text-foreground">
                              {usd(s.billed_cost)}
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
      </div>
    </div>
  );
}
