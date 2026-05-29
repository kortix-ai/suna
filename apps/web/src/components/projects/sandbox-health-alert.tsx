'use client';

/**
 * Project-level sandbox build health alert.
 *
 * Polls `/sandbox-health` which asks Daytona for the live state of the current
 * default-branch commit's expected image and surfaces the most recent failed
 * build from the append-only log. Renders nothing for the steady-state
 * (ready) case — only shows up when something needs attention.
 */

import * as React from 'react';
import { useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Loader2, RefreshCw, Sparkles } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { useCustomizeStore } from '@/stores/customize-store';
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

type Severity = 'critical' | 'building';

function severityOf(health: ProjectSandboxHealth | null | undefined): Severity | null {
  if (!health) return null;
  if (health.latest_failure && !health.ready) return 'critical';
  if (health.building && !health.ready) return 'building';
  return null;
}

const SEVERITY_TONE: Record<Severity, { text: string; icon: string; dot: string }> = {
  critical: {
    text: 'text-destructive',
    icon: 'text-destructive',
    dot: 'bg-destructive',
  },
  building: {
    text: 'text-muted-foreground',
    icon: 'text-muted-foreground',
    dot: 'bg-blue-500',
  },
};

const SEVERITY_LABEL: Record<Severity, string> = {
  critical: 'Fix sandbox build',
  building: 'Sandbox build running…',
};

const CATEGORY_LABEL: Record<string, string> = {
  dockerfile: 'Dockerfile build failed',
  git: 'Repository access failed',
  tunnel: 'Sandbox callback unreachable',
  provider: 'Sandbox provider error',
  timeout: 'Build timed out',
  runtime: 'Runtime artifact missing',
  unknown: 'Build failed',
};

/** Shared health query — pollable, used by the alert and the settings panel. */
export function useSandboxHealth(projectId: string) {
  return useQuery<ProjectSandboxHealth>({
    queryKey: SANDBOX_HEALTH_QUERY_KEY(projectId),
    queryFn: () => getProjectSandboxHealth(projectId),
    staleTime: 8_000,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return 15_000;
      if (data.building || data.latest_failure) return 8_000;
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
    mutationFn: (slug?: string) => rebuildProjectSnapshot(projectId, slug),
    onSuccess: () => {
      toast.success('Rebuild started');
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
  const openCustomize = useCustomizeStore((s) => s.openCustomize);
  const { retry, fixWithAgent } = useSandboxRecovery(projectId);
  const failure = health.latest_failure;
  const canFixWithAgent = !!failure && !!health.latest_build && health.latest_build.status === 'ready';

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
            {severity === 'critical' ? 'Sandbox build failed' : 'Sandbox build running'}
          </span>
        </div>
        <p className="text-xs text-muted-foreground">
          {severity === 'critical'
            ? 'New sessions will rebuild on the next start, but the most recent build is failing.'
            : 'A new sandbox image is building. Sessions can start once it’s ready.'}
        </p>
      </div>

      {failure && (
        <div className="border-t border-border/60 px-4 py-3">
          <div className="mb-1.5 flex items-center gap-2">
            <span className="rounded-full border border-destructive/20 bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">
              {CATEGORY_LABEL[failure.error_category ?? 'unknown'] ?? failure.error_category}
            </span>
            <code className="font-mono text-xs text-muted-foreground">{failure.slug}</code>
          </div>
          {failure.error && (
            <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/60 p-2 text-xs text-muted-foreground">
              {failure.error}
            </pre>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t border-border/60 px-4 py-3">
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5"
          disabled={retry.isPending}
          onClick={() => retry.mutate(failure?.slug)}
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
          onClick={() => openCustomize('sandbox')}
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
