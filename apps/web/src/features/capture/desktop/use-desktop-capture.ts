'use client';

import { approveCaptureDeviceGrant, revokeCaptureDevice } from '@kortix/sdk';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { errorToast } from '@/components/ui/toast';
import { useMemo } from 'react';

import { useProjectSelectorData } from '@/features/workspace/project-selector/use-project-selector-data';
import { useCurrentAccountStore } from '@/stores/current-account-store';
import {
  desktopCapturePause,
  desktopCaptureRequestGrants,
  desktopCaptureResume,
  desktopCaptureSet,
  desktopCaptureSignInCancel,
  desktopCaptureSignInFinish,
  desktopCaptureSignInStart,
  desktopCaptureSignOut,
  desktopCaptureStatus,
  isDesktop,
  openExternalRoute,
  type DesktopCaptureStatus,
} from '@/lib/desktop';

import { connectDesktopCapture } from './connect-desktop-capture';

export const DESKTOP_CAPTURE_STATUS_KEY = ['desktop-capture-status'] as const;

/** The bundled engine's status. `null` in a browser or a desktop build without Capture. */
export function useDesktopCaptureStatus({ poll = false }: { poll?: boolean } = {}) {
  return useQuery({
    queryKey: DESKTOP_CAPTURE_STATUS_KEY,
    queryFn: async () => (await desktopCaptureStatus()) ?? null,
    enabled: isDesktop(),
    // While the dialog is open: the person answers macOS prompts outside it.
    refetchInterval: poll ? 2_000 : 30_000,
  });
}

/**
 * The organization Capture records this computer for: the selected account,
 * else the first. Capture is organization-scoped; projects stay out of it.
 *
 * `projectId` bridges to today's device sign-in, which still names a project
 * with capture on: the one this computer records into when it belongs to this
 * organization, else its most recently opened one. It goes away when the
 * account-scoped device grant lands (backend lane).
 */
export function useCaptureOrganization(recordingInto?: string | null) {
  const { sections, listsLoading } = useProjectSelectorData();
  const selected = useCurrentAccountStore((state) => state.selectedAccountId);
  return useMemo(() => {
    const section = sections.find((candidate) => candidate.accountId === selected) ?? sections[0] ?? null;
    const captureProjects = (section?.projects ?? []).filter((project) => project.experimental?.capture);
    const project =
      captureProjects.find((candidate) => candidate.project_id === recordingInto) ?? captureProjects[0] ?? null;
    return {
      loading: listsLoading,
      accountId: section?.accountId ?? null,
      name: section?.accountName ?? '',
      /** Capture is on for this organization. */
      enabled: Boolean(project),
      projectId: project?.project_id ?? null,
    };
  }, [sections, listsLoading, selected, recordingInto]);
}

/**
 * Every Capture action of "This computer". Turning on is the engine's own
 * device sign-in (`/v1/capture/device/*`), approved with this person's
 * session; the device keeps its own identity and never touches the computer
 * agent.
 */
export function useDesktopCaptureActions(
  projectId: string,
  { onWaitingOnPage }: { onWaitingOnPage: () => void },
) {
  const queryClient = useQueryClient();
  const settle = (next: DesktopCaptureStatus | null | undefined) => {
    if (next) queryClient.setQueryData(DESKTOP_CAPTURE_STATUS_KEY, next);
    void queryClient.invalidateQueries({ queryKey: DESKTOP_CAPTURE_STATUS_KEY });
  };
  // Each action reports its own failure (this replaces the app-wide generic toast).
  const options = {
    retry: false,
    onSuccess: settle,
    onError: (error: Error) => errorToast(error.message),
  } as const;

  const turnOn = useMutation({
    ...options,
    // The dialog shows a failed start inline, with "Try again".
    onError: () => undefined,
    mutationFn: async (view: DesktopCaptureStatus) => {
      // Signed in for this organization already: only the switch.
      if (view.signedIn && view.projectId === projectId && !view.signInRequired)
        return desktopCaptureSet({ on: true });
      const result = await connectDesktopCapture(projectId, {
        start: desktopCaptureSignInStart,
        approve: approveCaptureDeviceGrant,
        finish: desktopCaptureSignInFinish,
        cancel: desktopCaptureSignInCancel,
        openApproval: (url) => {
          onWaitingOnPage();
          if (!openExternalRoute(url.replace(/^https?:\/\/[^/]+/, ''))) window.open(url, '_blank');
        },
      });
      if (!result.ok) throw new Error(result.error || 'Capture did not start.');
      return result.status;
    },
  });
  const set = useMutation({ ...options, mutationFn: desktopCaptureSet });
  const pause = useMutation({ ...options, mutationFn: () => desktopCapturePause(60) });
  const resume = useMutation({ ...options, mutationFn: desktopCaptureResume });
  const grants = useMutation({ ...options, mutationFn: desktopCaptureRequestGrants });
  const signOut = useMutation({
    ...options,
    // Kortix first (the device loses access), then this computer forgets it and the service goes.
    mutationFn: async (view: DesktopCaptureStatus) => {
      if (view.projectId && view.deviceId)
        await revokeCaptureDevice(view.projectId, view.deviceId).catch(() => undefined);
      return desktopCaptureSignOut();
    },
  });
  return { turnOn, set, pause, resume, grants, signOut };
}
