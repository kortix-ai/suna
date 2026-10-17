'use client';

import { errorToast, successToast } from '@/components/ui/toast';
import { useTranslations } from '@/i18n/use-translations';
import type { SandboxRuntimeStatus } from '@kortix/sdk';
import {
  fixSandboxWithAgent,
  getProjectSandboxHealth,
  rebuildProjectSnapshot,
  type ProjectSandboxHealth,
} from '@kortix/sdk';
import { qk } from '@kortix/sdk/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useCallback } from 'react';
import {
  formatSandboxProviders,
  sandboxHealthRefetchInterval,
  type SandboxAlertSeverity,
} from './sandbox-alert-state';
import type { SidebarAlertTone } from './sidebar-alert';
export const SANDBOX_HEALTH_QUERY_KEY = (projectId: string) => ['sandbox-health', projectId];
export function useSandboxHealth(projectId: string) {
  return useQuery<ProjectSandboxHealth>({
    queryKey: SANDBOX_HEALTH_QUERY_KEY(projectId),
    queryFn: () => getProjectSandboxHealth(projectId),
    staleTime: 30_000,
    refetchInterval: (query) => sandboxHealthRefetchInterval(query.state.data),
    refetchOnWindowFocus: true,
  });
}

export function useSandboxRecovery(projectId: string) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const router = useRouter();
  const queryClient = useQueryClient();

  const invalidate = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: SANDBOX_HEALTH_QUERY_KEY(projectId) });
    queryClient.invalidateQueries({ queryKey: qk.project.snapshots(projectId) });
  }, [queryClient, projectId]);

  const retry = useMutation({
    mutationFn: (slug?: string) => rebuildProjectSnapshot(projectId, slug),
    onSuccess: () => {
      successToast(tI18nComplete.raw('text92a4120f7589'));
      invalidate();
    },
    onError: (err: Error) => errorToast(err.message || tI18nComplete.raw('text34c50a6ee575')),
  });

  const fixWithAgent = useMutation({
    mutationFn: () => fixSandboxWithAgent(projectId),
    onSuccess: ({ session_id }) => {
      successToast(tI18nComplete.raw('text4b303ca7f76c'));
      router.push(`/projects/${projectId}/sessions/${session_id}`);
      invalidate();
    },
    onError: (err: Error) => errorToast(err.message || tI18nComplete.raw('text02d6613cab50')),
  });

  return { retry, fixWithAgent };
}

export const SEVERITY_TONE: Record<SandboxAlertSeverity, SidebarAlertTone> = {
  critical: 'critical',
  warning: 'warning',
  building: 'neutral',
};

export const SEVERITY_LABEL: Record<SandboxAlertSeverity, string> = {
  critical: 'Sandbox build failing',
  warning: 'Sandbox partly unavailable',
  building: 'Sandbox build running…',
};

export const MEMBER_LABEL: Partial<Record<SandboxAlertSeverity, string>> = {
  critical: 'Sessions unavailable',
  building: 'Preparing sandbox…',
};

export const MEMBER_TEXT: Partial<Record<SandboxAlertSeverity, string>> = {
  critical: 'New sessions can’t start right now. An owner or admin of this project can fix it.',
  building: 'Sessions can start once it’s ready.',
};

export const MEMBER_TONE: Partial<Record<SandboxAlertSeverity, SidebarAlertTone>> = {
  critical: 'warning',
  building: 'neutral',
};

export const CATEGORY_LABEL: Record<string, string> = {
  quota: 'Snapshot quota reached',
  dockerfile: 'Dockerfile build failed',
  git: 'Repository access failed',
  tunnel: 'Sandbox callback unreachable',
  provider: 'Sandbox provider error',
  timeout: 'Build timed out',
  runtime: 'Runtime artifact missing',
  unknown: 'Build failed',
};

export const CATEGORY_TEXT: Record<'critical' | 'warning', string> = {
  critical: 'text-destructive',
  warning: 'text-kortix-orange',
};

export const CATEGORY_CAUSE: Record<string, string> = {
  quota: 'This project has no room for another sandbox image. Removing an old one frees space.',
  dockerfile: 'A step in the project’s Dockerfile did not finish.',
  git: 'The build could not read the project’s repository. Its access may have expired.',
  tunnel: 'The sandbox could not reach Kortix while it was being built.',
  provider: 'The sandbox provider refused the build. This is usually temporary.',
  timeout: 'The build ran past its time limit and was stopped.',
  runtime: 'The build finished, but without the agent it needs to run.',
  unknown: 'The build stopped before it finished.',
};

export const CATEGORY_CAUSE_FALLBACK = CATEGORY_CAUSE.unknown;

export function describeSandboxSeverity(
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
