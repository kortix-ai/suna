'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure';
import Hint from '@/components/ui/hint';
import Loading from '@/components/ui/loading';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar';
import { errorToast, successToast } from '@/components/ui/toast';
import {
  fixSandboxWithAgent,
  getProjectSandboxHealth,
  rebuildProjectSnapshot,
  type ProjectSandboxHealth,
} from '@/lib/projects-client';
import { cn } from '@/lib/utils';
import { useCustomizeStore } from '@/stores/customize-store';
import { DangerTriangleSolid, SparklesSolid } from '@mynaui/icons-react';

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
      successToast('Rebuild started');
      invalidate();
    },
    onError: (err: Error) => errorToast(err.message || 'Failed to start build'),
  });

  const fixWithAgent = useMutation({
    mutationFn: () => fixSandboxWithAgent(projectId),
    onSuccess: ({ session_id }) => {
      successToast('Started a session to fix the sandbox build');
      router.push(`/projects/${projectId}/sessions/${session_id}`);
      invalidate();
    },
    onError: (err: Error) => errorToast(err.message || 'Could not start the fix session'),
  });

  return { retry, fixWithAgent };
}

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
  const canFixWithAgent =
    !!failure && !!health.latest_build && health.latest_build.status === 'ready';

  return (
    <div className="w-full overflow-hidden">
      <div className="px-2 pb-3">
        <p className="text-muted-foreground text-xs text-balance">
          {severity === 'critical'
            ? 'New sessions will rebuild on the next start, but the most recent build is failing.'
            : 'A new sandbox image is building. Sessions can start once it’s ready.'}
        </p>
        {!failure && (
          <Button
            variant="transparent"
            size="sm"
            className="text-foreground/70 m-0 inline-flex h-fit w-fit p-0 align-baseline text-xs"
            onClick={() => openCustomize('sandbox')}
          >
            Details
          </Button>
        )}
      </div>

      {failure && (
        <div className="border-border/60 border-t px-4 py-3">
          <div className="mb-1.5 flex min-w-0 items-center gap-2">
            <span className="border-destructive/20 bg-destructive/10 text-destructive shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium">
              {CATEGORY_LABEL[failure.error_category ?? 'unknown'] ?? failure.error_category}
            </span>
            <code className="text-muted-foreground min-w-0 truncate font-mono text-xs">
              {failure.slug}
            </code>
            <Button
              variant="link"
              size="sm"
              className="text-muted-foreground ml-auto h-auto shrink-0 p-0 text-xs"
              onClick={() => openCustomize('sandbox')}
            >
              Details
            </Button>
          </div>
          {failure.error && (
            <pre className="bg-muted/60 text-muted-foreground max-h-32 overflow-auto rounded-lg p-2 text-xs break-words whitespace-pre-wrap">
              {failure.error}
            </pre>
          )}
        </div>
      )}

      <div className="border-border flex flex-col gap-2 border-t p-3">
        {canFixWithAgent && (
          <Button
            size="sm"
            className="w-full"
            disabled={fixWithAgent.isPending}
            onClick={() => fixWithAgent.mutate()}
          >
            {fixWithAgent.isPending ? (
              <Loading className="text-foreground! size-3.5" />
            ) : (
              <SparklesSolid className="size-3.5" />
            )}
            Fix with agent
          </Button>
        )}
        <Button
          size="sm"
          variant="secondary"
          className="w-full border"
          disabled={retry.isPending}
          onClick={() => retry.mutate(failure?.slug)}
        >
          {retry.isPending ? (
            <Loading className="text-foreground! size-3.5" />
          ) : (
            <RefreshCw className="size-3.5" />
          )}
          Retry build
        </Button>
      </div>
    </div>
  );
}

export function ProjectSandboxAlert({ projectId }: { projectId: string }) {
  const [isOpen, setIsOpen] = useState(false);
  const { data } = useSandboxHealth(projectId);
  const severity = severityOf(data);
  if (!severity || !data) return null;
  const tone = SEVERITY_TONE[severity];

  return (
    <SidebarMenuItem>
      <Disclosure
        variant="outline"
        open={isOpen}
        onOpenChange={setIsOpen}
        className={cn(
          'w-full overflow-hidden rounded-md border-none text-sm shadow-none',
          isOpen && 'bg-foreground/5',
        )}
      >
        <DisclosureTrigger>
          <SidebarMenuButton
            className={cn('px-2.5 text-sm! font-medium [&_svg]:size-3.5!', tone.text)}
          >
            {severity === 'building' ? (
              <Loading className="text-muted-foreground!" />
            ) : (
              <DangerTriangleSolid className="size-4" />
            )}
            <span>{SEVERITY_LABEL[severity]}</span>
          </SidebarMenuButton>
        </DisclosureTrigger>
        <DisclosureContent variant="outline">
          <SandboxAlertContent projectId={projectId} health={data} severity={severity} />
        </DisclosureContent>
      </Disclosure>
    </SidebarMenuItem>
  );
}

export function ProjectSandboxAlertRailItem({ projectId }: { projectId: string }) {
  const { data } = useSandboxHealth(projectId);
  const severity = severityOf(data);
  if (!severity || !data) return null;
  const tone = SEVERITY_TONE[severity];

  return (
    <Popover>
      <Hint label={SEVERITY_LABEL[severity]}>
        <PopoverTrigger asChild>
          <SidebarMenuButton type="button" aria-label={SEVERITY_LABEL[severity]}>
            {severity === 'building' ? (
              <Loading className={cn('size-4 animate-spin', tone.icon)} />
            ) : (
              <DangerTriangleSolid className={cn('size-4', tone.icon)} />
            )}
            {severity !== 'building' && (
              <span className={cn('absolute top-1.5 right-1.5 size-1.5 rounded-full', tone.dot)} />
            )}
          </SidebarMenuButton>
        </PopoverTrigger>
      </Hint>
      <PopoverContent side="right" align="end" sideOffset={12} className="w-96 p-0">
        <SandboxAlertContent projectId={projectId} health={data} severity={severity} />
      </PopoverContent>
    </Popover>
  );
}
