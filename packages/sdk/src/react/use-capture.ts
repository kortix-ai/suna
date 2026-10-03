'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  approveCaptureDeviceGrant,
  denyCaptureDeviceGrant,
  getCaptureDeviceGrant,
} from '../core/rest/projects-client';
import { contract } from './query-contracts';
import { qk } from './query-keys';

/**
 * The Kortix Capture device asking to sign in with `userCode` (the approval
 * page). A grant expires in 15 minutes and is decided once, so it is `volatile`.
 */
export function useCaptureDeviceGrant(userCode: string | null | undefined) {
  return useQuery({
    queryKey: qk.capture.deviceGrant(userCode ?? ''),
    queryFn: () => getCaptureDeviceGrant(userCode as string),
    enabled: !!userCode,
    ...contract('volatile'),
  });
}

/** Pair the asking device to the caller in one of their projects with capture on. */
export function useApproveCaptureDevice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: { userCode: string; projectId: string }) =>
      approveCaptureDeviceGrant(args.userCode, args.projectId),
    onSuccess: (grant, args) => queryClient.setQueryData(qk.capture.deviceGrant(args.userCode), grant),
  });
}

/** Refuse the asking device. */
export function useDenyCaptureDevice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userCode: string) => denyCaptureDeviceGrant(userCode),
    onSuccess: (grant, userCode) => queryClient.setQueryData(qk.capture.deviceGrant(userCode), grant),
  });
}
