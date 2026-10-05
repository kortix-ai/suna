'use client';

import { approveCaptureDeviceGrant, revokeCaptureDevice } from '@kortix/sdk';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { errorToast } from '@/components/ui/toast';
import { useMemo } from 'react';

import { useProjectSelectorData } from '@/features/workspace/project-selector/use-project-selector-data';
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

/** The project, when the person can see it and its `capture` feature flag is on. */
export function useCaptureProject(projectId: string) {
  const { sections, listsLoading } = useProjectSelectorData();
  const project = useMemo(
    () =>
      sections
        .flatMap((section) => section.projects)
        .find((candidate) => candidate.project_id === projectId && candidate.experimental?.capture) ?? null,
    [sections, projectId],
  );
  return { project, loading: listsLoading };
}

/**
 * Every Capture action of the dialog. Turning on is the engine's own device
 * sign-in (`/v1/capture/device/*`), approved with this person's session and
 * this computer's machine id; it never touches the computer agent.
 */
export function useDesktopCaptureActions(projectId: string, { onWaitingOnPage }: { onWaitingOnPage: () => void }) {
  const queryClient = useQueryClient();
  const settle = (next: DesktopCaptureStatus | null | undefined) => {
    if (next) queryClient.setQueryData(DESKTOP_CAPTURE_STATUS_KEY, next);
    void queryClient.invalidateQueries({ queryKey: DESKTOP_CAPTURE_STATUS_KEY });
  };
  // Each action reports its own failure (this replaces the app-wide generic toast).
  const options = { retry: false, onSuccess: settle, onError: (error: Error) => errorToast(error.message) } as const;

  const turnOn = useMutation({
    ...options,
    // The dialog shows a failed start inline, with "Try again".
    onError: () => undefined,
    mutationFn: async (view: DesktopCaptureStatus) => {
      // Signed in to this project already: only the switch.
      if (view.signedIn && view.projectId === projectId && !view.signInRequired) return desktopCaptureSet({ on: true });
      const machineId = view.machineId;
      const result = await connectDesktopCapture(projectId, {
        start: desktopCaptureSignInStart,
        approve: (userCode, target) => approveCaptureDeviceGrant(userCode, target, machineId ? { machineId } : {}),
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
      if (view.projectId && view.deviceId) await revokeCaptureDevice(view.projectId, view.deviceId).catch(() => undefined);
      return desktopCaptureSignOut();
    },
  });
  return { turnOn, set, pause, resume, grants, signOut };
}
