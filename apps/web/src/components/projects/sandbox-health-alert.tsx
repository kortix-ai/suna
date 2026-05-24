'use client';

/**
 * Project-level sandbox build health alert.
 *
 * The sandbox snapshot is the foundation of the whole product: no ready image
 * means no new session can boot. When a build fails (or the very first build is
 * still running) the user needs to know *everywhere* in the project — not buried
 * in a settings sub-tab — so this renders a prominent alert in the project
 * sidebar (expanded row + collapsed rail icon) with one-click recovery:
 *   • Retry build      — re-run the snapshot build for the branch tip.
 *   • Fix with agent    — open a session pre-seeded with the classified error so
 *                         an agent can fix the Dockerfile and open a CR.
 *
 * Severity:
 *   • critical (red)   — build failed AND no healthy snapshot remains → sessions
 *                        cannot boot. This is the product-down state.
 *   • degraded (amber) — build failed but older healthy snapshots still serve
 *                        sessions (running slightly stale code).
 *   • building (muted) — first build still running, nothing ready yet (expected,
 *                        informational — not an error).
 */

import * as React from 'react';
import { useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Loader2, RefreshCw, Sparkles } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import {
  fixSandboxWithAgent,
  getProjectSandboxHealth,
  rebuildProjectSnapshot,
  type ProjectSandboxHealth,
} from '@/lib/projects-client';

export const SANDBOX_HEALTH_QUERY_KEY = (projectId: string) => ['sandbox-health', projectId];

type Severity = 'critical' | 'degraded' | 'building';

function severityOf(health: ProjectSandboxHealth | null | undefined): Severity | null {
  if (!health) return null;
  if (health.failure) return health.ready_count === 0 ? 'critical' : 'degraded';
  if (!health.healthy && health.building) return 'building';
  return null;
}

const SEVERITY_TONE: Record<Severity, { text: string; icon: string; dot: string }> = {
  critical: {
    text: 'text-destructive',
    icon: 'text-destructive',
    dot: 'bg-destructive',
  },
  degraded: {
    text: 'text-amber-600 dark:text-amber-400',
    icon: 'text-amber-600 dark:text-amber-400',
    dot: 'bg-amber-500',
  },
  building: {
    text: 'text-muted-foreground',
    icon: 'text-muted-foreground',
    dot: 'bg-blue-500',
  },
};

const SEVERITY_LABEL: Record<Severity, string> = {
  critical: 'Fix sandbox build',
  degraded: 'Sandbox build failing',
  building: 'Building first sandbox…',
};

/** Shared health query — pollable, used by the alert and the settings panel. */
export function useSandboxHealth(projectId: string) {
  return useQuery<ProjectSandboxHealth>({
    queryKey: SANDBOX_HEALTH_QUERY_KEY(projectId),
    queryFn: () => getProjectSandboxHealth(projectId),
    staleTime: 8_000,
    refetchInterval: (query) => {
      const data = query.state.data;
      // Poll faster while something is in flight or broken; slower steady state
      // so a freshly-introduced failure still surfaces within ~30s.
      if (!data) return 15_000;
      if (data.building || data.failure) return 8_000;
      return 30_000;
    },
    refetchOnWindowFocus: true,
  });
}

/** Shared recovery mutations (retry + fix-with-agent) reused across surfaces. */
export function useSandboxRecovery(projectId: string) {
  const router = useRouter();
  const queryClient = useQueryClient();

  const invalidate = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: SANDBOX_HEALTH_QUERY_KEY(projectId) });
    queryClient.invalidateQueries({ queryKey: ['project-snapshots', projectId] });
  }, [queryClient, projectId]);

  const retry = useMutation({
    mutationFn: () => rebuildProjectSnapshot(projectId),
    onSuccess: (result) => {
      const labels: Record<typeof result.status, string> = {
        'started': 'Snapshot build started',
        'already-building': 'A build is already in progress',
        'already-ready': 'Latest commit is already built',
        'failed-to-start': 'Could not start build',
      };
      toast.success(labels[result.status]);
      invalidate();
    },
    onError: (err: Error) => toast.error(err.message || 'Failed to start build'),
  });

  const fixWithAgent = useMutation({
    mutationFn: () => fixSandboxWithAgent(projectId),
    onSuccess: ({ session_id }) => {
      toast.success('Started a session to fix the sandbox build');
      router.push(`/projects/${projectId}/sessions/${session_id}`);
      invalidate();
    },
    onError: (err: Error) =>
      toast.error(err.message || 'Could not start the fix session'),
  });

  return { retry, fixWithAgent };
}

const CATEGORY_LABEL: Record<string, string> = {
  dockerfile: 'Dockerfile build failed',
  git: 'Repository access failed',
  tunnel: 'Sandbox callback unreachable',
  provider: 'Sandbox provider error',
  timeout: 'Build timed out',
  runtime: 'Runtime artifact missing',
  unknown: 'Build failed',
};

/** The popover body: what's wrong + how to recover. */
function SandboxAlertContent({
  projectId,
  health,
  severity,
}: {
  projectId: string;
  health: ProjectSandboxHealth;
  severity: Severity;
}) {
  const router = useRouter();
  const { retry, fixWithAgent } = useSandboxRecovery(projectId);
  const failure = health.failure;
  const canFixWithAgent = !!failure?.fixable_by_agent && health.ready_count > 0;

  return (
    <div className="w-full overflow-hidden">
      <div className="space-y-1 px-4 pt-4 pb-3">
        <div className="flex items-center gap-2">
          {severity === 'building' ? (
            <Loader2 className={cn('size-4 animate-spin', SEVERITY_TONE[severity].icon)} />
          ) : (
            <AlertTriangle className={cn('size-4', SEVERITY_TONE[severity].icon)} />
          )}
          <span className={cn('text-sm font-semibold', SEVERITY_TONE[severity].text)}>
            {severity === 'critical'
              ? 'Sandbox build failed'
              : severity === 'degraded'
                ? 'Latest build failed'
                : 'Building first sandbox'}
          </span>
        </div>
        <p className="text-xs text-muted-foreground">
          {severity === 'critical'
            ? 'No healthy snapshot remains, so new sessions can’t start until this is fixed.'
            : severity === 'degraded'
              ? `Sessions still run on the last healthy snapshot (${health.ready_count} retained). New commits won’t apply until the build succeeds.`
              : 'This one-time build runs the first time a project is created. Sessions can start once it’s ready.'}
        </p>
      </div>

      {failure && (
        <div className="border-t border-border/60 px-4 py-3">
          <div className="mb-1.5 flex items-center gap-2">
            <span className="rounded-full border border-destructive/20 bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">
              {CATEGORY_LABEL[failure.category] ?? failure.category}
            </span>
            <code className="font-mono text-xs text-muted-foreground">
              {failure.commit_sha.slice(0, 7)}
            </code>
          </div>
          <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/60 p-2 text-xs text-muted-foreground">
            {failure.error}
          </pre>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t border-border/60 px-4 py-3">
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5"
          disabled={retry.isPending}
          onClick={() => retry.mutate()}
        >
          {retry.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
          Retry build
        </Button>
        {canFixWithAgent && (
          <Button
            size="sm"
            className="gap-1.5"
            disabled={fixWithAgent.isPending}
            onClick={() => fixWithAgent.mutate()}
          >
            {fixWithAgent.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
            Fix with agent
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto text-muted-foreground"
          onClick={() => router.push(`/projects/${projectId}/customize/settings`)}
        >
          Details
        </Button>
      </div>
    </div>
  );
}

/** Expanded sidebar row — renders an <li>; place inside a <SidebarMenu>. */
export function ProjectSandboxAlertNavItem({ projectId }: { projectId: string }) {
  const { data } = useSandboxHealth(projectId);
  const severity = severityOf(data);
  if (!severity || !data) return null;
  const tone = SEVERITY_TONE[severity];

  return (
    <SidebarMenuItem>
      <Popover>
        <PopoverTrigger asChild>
          <SidebarMenuButton className={cn('!text-sm font-normal [&_svg]:!size-4', tone.text)}>
            {severity === 'building' ? (
              <Loader2 className="animate-spin" />
            ) : (
              <AlertTriangle />
            )}
            <span>{SEVERITY_LABEL[severity]}</span>
            {severity !== 'building' && (
              <span className={cn('ml-auto size-1.5 rounded-full', tone.dot)} />
            )}
          </SidebarMenuButton>
        </PopoverTrigger>
        <PopoverContent side="right" align="end" sideOffset={12} className="w-96 p-0">
          <SandboxAlertContent projectId={projectId} health={data} severity={severity} />
        </PopoverContent>
      </Popover>
    </SidebarMenuItem>
  );
}

/** Collapsed icon-rail button — mirrors the rail's other icon buttons. */
export function ProjectSandboxAlertRailItem({ projectId }: { projectId: string }) {
  const { data } = useSandboxHealth(projectId);
  const severity = severityOf(data);
  if (!severity || !data) return null;
  const tone = SEVERITY_TONE[severity];

  return (
    <Popover>
      <Tooltip>
        <PopoverTrigger asChild>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={SEVERITY_LABEL[severity]}
              className="relative flex w-full items-center justify-center rounded-lg py-2 transition-colors duration-150 ease-out hover:bg-sidebar-accent"
            >
              {severity === 'building' ? (
                <Loader2 className={cn('size-4 animate-spin', tone.icon)} />
              ) : (
                <AlertTriangle className={cn('size-4', tone.icon)} />
              )}
              {severity !== 'building' && (
                <span className={cn('absolute right-1.5 top-1.5 size-1.5 rounded-full', tone.dot)} />
              )}
            </button>
          </TooltipTrigger>
        </PopoverTrigger>
        <TooltipContent side="right" sideOffset={12} className="text-xs">
          {SEVERITY_LABEL[severity]}
        </TooltipContent>
      </Tooltip>
      <PopoverContent side="right" align="start" sideOffset={12} className="w-96 p-0">
        <SandboxAlertContent projectId={projectId} health={data} severity={severity} />
      </PopoverContent>
    </Popover>
  );
}
