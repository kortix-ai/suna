'use client';

import { approveCaptureDeviceGrant, revokeCaptureDevice } from '@kortix/sdk';
import { useCaptureWorkspace } from '@kortix/sdk/react';
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

/**
 * The project the dialog opened from, the account that owns it (Capture's
 * tenant), and whether Capture is on for that account.
 */
export function useCaptureProject(projectId: string) {
  const { sections, listsLoading } = useProjectSelectorData();
  const project = useMemo(
    () => sections.flatMap((section) => section.projects).find((candidate) => candidate.project_id === projectId) ?? null,
    [sections, projectId],
  );
  const accountId = project?.account_id ?? null;
  const workspace = useCaptureWorkspace(accountId);
  return {
    project,
    accountId,
    captureOn: workspace.data?.enabled ?? false,
    loading: listsLoading || (!!accountId && workspace.isLoading),
  };
}

/**
 * Every Capture action of the dialog. Turning on is the engine's own device
 * sign-in (`/v1/capture/device/*`), approved with this person's session into
 * the account; it never touches the computer agent.
 */
export function useDesktopCaptureActions(
  accountId: string | null,
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
      if (!accountId) throw new Error('No account to record into.');
      // Signed in to this account already: only the switch.
      if (view.signedIn && view.accountId === accountId && !view.signInRequired)
        return desktopCaptureSet({ on: true });
      const result = await connectDesktopCapture(accountId, {
        start: desktopCaptureSignInStart,
        approve: (userCode, target) => approveCaptureDeviceGrant(userCode, target),
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
      if (view.accountId && view.deviceId)
        await revokeCaptureDevice(view.accountId, view.deviceId).catch(() => undefined);
      return desktopCaptureSignOut();
    },
  });
  return { turnOn, set, pause, resume, grants, signOut };
}
