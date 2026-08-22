'use client';

import { ArrowClockwiseIcon as RefreshCw } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';

import { projectSettingsSectionHref } from '@/features/workspace/capabilities/project-settings/project-settings-sections';
import { useCallback, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { errorToast, successToast } from '@/components/ui/toast';
import {
  type SandboxAlertSeverity,
  formatSandboxProviders,
  resolveSandboxAlertSeverity,
  sandboxHealthIsActive,
  selectCurrentSandboxFailure,
  selectSandboxStatus,
} from '@/features/workspace/project-sidebar/footer/sandbox-alert-state';
import {
  SidebarAlert,
  SidebarAlertActions,
  SidebarAlertBody,
  SidebarAlertText,
  type SidebarAlertTone,
} from '@/features/workspace/project-sidebar/footer/sidebar-alert';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { relativeTime } from '@/lib/relative-time';
import { useProjectCans } from '@/lib/use-project-can';
import { cn } from '@/lib/utils';
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

/**
 * Severity picks a tone from the shared footer palette — it no longer carries
 * its own colour strings. The old map spelled out a `text`, an `icon` and a
 * `dot` class per severity; `dot` and `icon` only ever fed the collapsed icon
 * rail, which no longer exists, and `text` was one hand-copy of what every
 * other footer alert already declares.
 */
const SEVERITY_TONE: Record<SandboxAlertSeverity, SidebarAlertTone> = {
  critical: 'critical',
  warning: 'warning',
  building: 'neutral',
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
 * "Details" appears twice — under the message when there is nothing to show,
 * and beside the error when there is. It used to be a `transparent` button in
 * one place and a `link` button with `hover:no-underline` in the other: two
 * descriptions of one word, and the second spent a class undoing its own
 * variant. One recipe, and `text-muted-foreground` instead of the
 * `text-foreground/70` opacity hack it was approximating.
 */
const DETAILS_LINK = 'text-muted-foreground hover:text-foreground h-fit w-fit p-0 text-xs';

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
      router.push(`/projects/${projectId}/sessions/${session_id}`);
      invalidate();
    },
    onError: (err: Error) => errorToast(err.message || 'Could not start the fix session'),
  });

  return { retry, fixWithAgent };
}

/** The two leaves the alert's controls assert, batched into one probe. */
const SANDBOX_ALERT_GATE_ACTIONS: readonly string[] = [
  PROJECT_ACTIONS.PROJECT_CUSTOMIZE_READ,
  PROJECT_ACTIONS.PROJECT_WRITE,
];

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
  const router = useRouter();
  // Sandbox templates is a section of the Customize bar's Settings tab now, so
  // "Details" is a route, not an overlay open.
  const openSandboxSection = useCallback(
    () => router.push(projectSettingsSectionHref(projectId, 'sandbox')),
    [router, projectId],
  );
  const { retry, fixWithAgent } = useSandboxRecovery(projectId);
  // The alert TEXT is information a plain member needs — "new sessions can't
  // start until this image builds" explains why the composer is refusing them.
  // Its CONTROLS are not: "Details" routes into Customize → Settings → Sandbox
  // (project.customize.read) and both recovery actions rebuild the project's
  // image (project.write). Neither leaf is in the member floor role (#6522), so
  // for a member every one of those buttons was a "forbidden" waiting to
  // happen. Hidden on a RECEIVED denial only, one batched probe for both.
  const caps = useProjectCans(projectId, SANDBOX_ALERT_GATE_ACTIONS);
  const canOpenDetails = caps[PROJECT_ACTIONS.PROJECT_CUSTOMIZE_READ]?.allowed !== false;
  const canRecover = caps[PROJECT_ACTIONS.PROJECT_WRITE]?.allowed !== false;
  const status = selectSandboxStatus(health);
  const failure = selectCurrentSandboxFailure(health);
  const failedAt = failure ? relativeTime(failure.finished_at ?? failure.started_at) : '';
  // Server-derived, and deliberately not re-derived here: the agent only helps
  // with repo-editable failures, and its fix session itself needs a bootable
  // sandbox — the very thing the failure may have denied. The API gates on
  // exactly this and answers 409 otherwise.
  const canFixWithAgent = status?.fix_with_agent_available ?? false;

  return (
    <>
      <SidebarAlertBody>
        <SidebarAlertText>{describeSandboxSeverity(severity, status)}</SidebarAlertText>
        {!failure && severity !== 'building' && canOpenDetails && (
          <Button
            variant="transparent"
            size="sm"
            className={cn(DETAILS_LINK, 'mt-1')}
            onClick={openSandboxSection}
          >
            Details
          </Button>
        )}
      </SidebarAlertBody>

      {failure && (
        <div className="border-border/60 space-y-1.5 border-t px-2 py-2.5">
          <div className="flex min-w-0 items-center gap-2">
            <Badge variant={severity === 'critical' ? 'destructive' : 'warning'} size="sm">
              {CATEGORY_LABEL[failure.error_category ?? 'unknown'] ?? failure.error_category}
            </Badge>
            {/* When it failed, always — an undated error reads as a live one. */}
            {failedAt ? (
              <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                {failedAt}
              </span>
            ) : null}
            {canOpenDetails ? (
              <Button
                variant="transparent"
                size="sm"
                className={cn(DETAILS_LINK, 'ml-auto')}
                onClick={openSandboxSection}
              >
                Details
              </Button>
            ) : null}
          </div>
          {failure.error && (
            <pre className="bg-muted text-muted-foreground max-h-32 overflow-auto overscroll-contain rounded-md p-2 text-xs wrap-break-word whitespace-pre-wrap">
              {failure.error}
            </pre>
          )}
        </div>
      )}

      {/* Nothing left to offer once both gates close — drop the divider too, so
          a member sees a clean informational card instead of an empty tray. */}
      {!canOpenDetails && !canRecover ? null : (
        <SidebarAlertActions>
          {severity === 'building' ? (
            canOpenDetails ? (
              <Button size="sm" variant="outline" className="w-full" onClick={openSandboxSection}>
                Details
              </Button>
            ) : null
          ) : (
            <>
              {canFixWithAgent && canRecover && (
                <Button
                  size="sm"
                  className="w-full"
                  disabled={fixWithAgent.isPending}
                  onClick={() => fixWithAgent.mutate()}
                >
                  {fixWithAgent.isPending ? (
                    <Loading className="size-3.5 shrink-0" />
                  ) : (
                    <SparklesSolid weight="fill" className="size-3.5 shrink-0" />
                  )}
                  {tI18nHardcoded.raw(
                    'autoFeaturesCoWorkerProjectSidebarFooterProjectSandboxAlertJsxe7d8ac75',
                  )}
                </Button>
              )}
              {canRecover ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="w-full"
                  disabled={retry.isPending}
                  onClick={() => retry.mutate(failure?.template_slug)}
                >
                  {retry.isPending ? (
                    <Loading className="size-3.5 shrink-0" />
                  ) : (
                    <RefreshCw className="size-3.5 shrink-0" />
                  )}
                  {tI18nHardcoded.raw(
                    'autoFeaturesCoWorkerProjectSidebarFooterProjectSandboxAlertJsx8794c0a3',
                  )}
                </Button>
              ) : null}
            </>
          )}
        </SidebarAlertActions>
      )}
    </>
  );
}

export function ProjectSandboxAlert({ projectId }: { projectId: string }) {
  const [isOpen, setIsOpen] = useState(false);
  const { data } = useSandboxHealth(projectId);
  const severity = resolveSandboxAlertSeverity(data);
  if (!severity || !data) return null;

  return (
    <SidebarAlert
      tone={SEVERITY_TONE[severity]}
      icon={
        severity === 'building' ? (
          <Loading className="in-[button]:text-foreground size-3.5 shrink-0" variant="spokes" />
        ) : (
          <DangerTriangleSolid weight="fill" className="size-4 shrink-0" />
        )
      }
      label={SEVERITY_LABEL[severity]}
      open={isOpen}
      onOpenChange={setIsOpen}
    >
      <SandboxAlertContent projectId={projectId} health={data} severity={severity} />
    </SidebarAlert>
  );
}
