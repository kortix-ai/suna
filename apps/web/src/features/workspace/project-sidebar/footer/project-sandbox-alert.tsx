'use client';

import { ArrowClockwiseIcon as RefreshCw } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useCallback, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure';
import Hint from '@/components/ui/hint';
import Loading from '@/components/ui/loading';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar';
import { errorToast, successToast } from '@/components/ui/toast';
import {
  type SandboxAlertSeverity,
  formatSandboxProviders,
  resolveSandboxAlertSeverity,
  sandboxHealthIsActive,
  selectCurrentSandboxFailure,
  selectSandboxStatus,
} from '@/features/workspace/project-sidebar/footer/sandbox-alert-state';
import { relativeTime } from '@/lib/relative-time';
import { cn } from '@/lib/utils';
import { useCustomizeStore } from '@/stores/customize-store';
import {
  type ProjectSandboxHealth,
  type SandboxRuntimeStatus,
  fixSandboxWithAgent,
  getProjectSandboxHealth,
  rebuildProjectSnapshot,
} from '@kortix/sdk';
import { qk } from '@kortix/sdk/react';
import {
  WarningIcon as DangerTriangleSolid,
  SparkleIcon as SparklesSolid,
} from '@phosphor-icons/react';

export const SANDBOX_HEALTH_QUERY_KEY = (projectId: string) => ['sandbox-health', projectId];

const SEVERITY_TONE: Record<SandboxAlertSeverity, { text: string; icon: string; dot: string }> = {
  critical: {
    text: 'text-destructive',
    icon: 'text-destructive',
    dot: 'bg-destructive',
  },
  warning: {
    text: 'text-kortix-orange',
    icon: 'text-kortix-orange',
    dot: 'bg-kortix-orange',
  },
  building: {
    text: 'text-muted-foreground',
    icon: 'text-muted-foreground',
    dot: 'bg-kortix-yellow',
  },
};

const SEVERITY_LABEL: Record<SandboxAlertSeverity, string> = {
  critical: 'Sandbox build failing',
  warning: 'Sandbox partly unavailable',
  building: 'Sandbox build running…',
};

const CATEGORY_LABEL: Record<string, string> = {
  quota: 'Snapshot quota reached',
  dockerfile: 'Dockerfile build failed',
  git: 'Repository access failed',
  tunnel: 'Sandbox callback unreachable',
  provider: 'Sandbox provider error',
  timeout: 'Build timed out',
  runtime: 'Runtime artifact missing',
  unknown: 'Build failed',
};

/**
 * One honest sentence about what the user can do right now. Never present-tense
 * a failure that no longer applies, and never imply sessions are down when only
 * one of several routable providers is.
 */
function describeSandboxSeverity(
  severity: SandboxAlertSeverity,
  status: SandboxRuntimeStatus | null,
): string {
  if (severity === 'building') {
    return 'A new sandbox image is building. Sessions can start once it’s ready.';
  }
  if (severity === 'warning') {
    const ready = formatSandboxProviders(status?.ready_providers ?? []);
    const failed = formatSandboxProviders(status?.failed_providers ?? []);
    return failed && ready
      ? `The image is ready on ${ready} but failing on ${failed}, so some new sessions won’t start.`
      : 'The sandbox image is unavailable on some providers, so some new sessions won’t start.';
  }
  return 'New sessions can’t start until this image builds.';
}

export function useSandboxHealth(projectId: string) {
  return useQuery<ProjectSandboxHealth>({
    queryKey: SANDBOX_HEALTH_QUERY_KEY(projectId),
    queryFn: () => getProjectSandboxHealth(projectId),
    staleTime: 30_000,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return 30_000;
      if (sandboxHealthIsActive(data)) return 8_000;
      return 120_000;
    },
    refetchOnWindowFocus: true,
  });
}

export function useSandboxRecovery(projectId: string) {
  const router = useRouter();
  const queryClient = useQueryClient();

  const invalidate = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: SANDBOX_HEALTH_QUERY_KEY(projectId) });
    queryClient.invalidateQueries({ queryKey: qk.project.snapshots(projectId) });
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
      router.push(`/workspaces/${projectId}/sessions/${session_id}`);
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
  severity: SandboxAlertSeverity;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const openCustomize = useCustomizeStore((s) => s.openCustomize);
  const { retry, fixWithAgent } = useSandboxRecovery(projectId);
  const status = selectSandboxStatus(health);
  const failure = selectCurrentSandboxFailure(health);
  const failedAt = failure ? relativeTime(failure.finished_at ?? failure.started_at) : '';
  // Server-derived, and deliberately not re-derived here: the agent only helps
  // with repo-editable failures, and its fix session itself needs a bootable
  // sandbox — the very thing the failure may have denied. The API gates on
  // exactly this and answers 409 otherwise.
  const canFixWithAgent = status?.fix_with_agent_available ?? false;

  return (
    <div className="w-full overflow-hidden">
      <div className="px-2 pb-3">
        <p className="text-muted-foreground text-xs text-balance">
          {describeSandboxSeverity(severity, status)}
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
        <div className="border-border/60 border-t px-2 py-3">
          <div className="mb-1.5 flex min-w-0 items-center gap-2">
            <Badge variant={severity === 'critical' ? 'destructive' : 'warning'} size="sm">
              {CATEGORY_LABEL[failure.error_category ?? 'unknown'] ?? failure.error_category}
            </Badge>
            {/* When it failed, always — an undated error reads as a live one. */}
            {failedAt ? (
              <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                {failedAt}
              </span>
            ) : null}
            <Button
              variant="link"
              size="sm"
              className="text-foreground/70 m-0 ml-auto inline-flex h-fit w-fit p-0 text-xs hover:no-underline"
              onClick={() => openCustomize('sandbox')}
            >
              Details
            </Button>
          </div>
          {failure.error && (
            <pre className="bg-muted text-muted-foreground max-h-32 overflow-auto rounded-lg p-2 text-xs wrap-break-word whitespace-pre-wrap">
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
              <SparklesSolid weight="fill" className="size-3.5" />
            )}
            {tI18nHardcoded.raw(
              'autoFeaturesCoWorkerProjectSidebarFooterProjectSandboxAlertJsxe7d8ac75',
            )}
          </Button>
        )}
        <Button
          size="sm"
          variant="secondary"
          className="w-full border"
          disabled={retry.isPending}
          onClick={() => retry.mutate(failure?.template_slug)}
        >
          {retry.isPending ? (
            <Loading className="text-foreground! size-3.5" />
          ) : (
            <RefreshCw className="size-3.5" />
          )}
          {tI18nHardcoded.raw(
            'autoFeaturesCoWorkerProjectSidebarFooterProjectSandboxAlertJsx8794c0a3',
          )}
        </Button>
      </div>
    </div>
  );
}

export function ProjectSandboxAlert({ projectId }: { projectId: string }) {
  const [isOpen, setIsOpen] = useState(false);
  const { data } = useSandboxHealth(projectId);
  const severity = resolveSandboxAlertSeverity(data);
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
              <DangerTriangleSolid weight="fill" className="size-4" />
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
  const severity = resolveSandboxAlertSeverity(data);
  if (!severity || !data) return null;
  const tone = SEVERITY_TONE[severity];

  return (
    <Popover>
      <Hint label={SEVERITY_LABEL[severity]}>
        <PopoverTrigger asChild>
          <SidebarMenuButton type="button" aria-label={SEVERITY_LABEL[severity]}>
            {severity === 'building' ? (
              <Loading className={cn('size-4', tone.icon)} />
            ) : (
              <DangerTriangleSolid weight="fill" className={cn('size-4', tone.icon)} />
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
