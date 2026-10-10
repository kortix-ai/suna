'use client';

import { approveCaptureDeviceGrant, revokeCaptureDevice } from '@kortix/sdk';
import { useCaptureWorkspace } from '@kortix/sdk/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { errorToast } from '@/components/ui/toast';
import { useAccountsList } from '@/hooks/account/use-accounts-list';
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
import { useCurrentAccountStore } from '@/stores/current-account-store';

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
 * A Kortix account as Kortix Capture's tenant: its name and whether Kortix
 * Capture is on for it. Capture takes no project.
 */
export function useCaptureOrganization(accountId: string | null) {
  const accounts = useAccountsList();
  const account =
    (accounts.data ?? []).find((candidate) => candidate.account_id === accountId) ?? null;
  const workspace = useCaptureWorkspace(accountId);
  return {
    accountId,
    name: account?.name ?? '',
    captureOn: workspace.data?.enabled ?? false,
    loading: accounts.isLoading || (!!accountId && workspace.isLoading),
  };
}

/**
 * The account "This computer" opens for: the one this computer is signed in
 * to, else the selected account, else the first. `null` while unknown.
 */
export function useThisComputerAccountId(): string | null {
  const status = useDesktopCaptureStatus();
  const accounts = useAccountsList();
  const selected = useCurrentAccountStore((state) => state.selectedAccountId);
  const list = accounts.data ?? [];
  return (
    status.data?.accountId ??
    list.find((candidate) => candidate.account_id === selected)?.account_id ??
    list[0]?.account_id ??
    null
  );
}

/** The routes of Kortix Capture's top-level area. */
export const captureRoutes = {
  thisComputer: (accountId: string) => `/capture/${accountId}/this-computer`,
  device: (accountId: string, deviceId: string) => `/capture/${accountId}/devices/${deviceId}`,
};

/**
 * Every Capture action of "This computer". Turning on is the engine's own
 * device sign-in (`/v1/capture/device/*`), approved with this person's
 * session into the account; the device keeps its own identity and never
 * touches the computer agent.
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
