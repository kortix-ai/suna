'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  approveCaptureDeviceGrant,
  denyCaptureDeviceGrant,
  getCaptureChunkMedia,
  getCaptureDays,
  getCaptureDeviceGrant,
  getCaptureFrame,
  getCapturePolicy,
  getCaptureTimeline,
  getCaptureTimelineItems,
  getCaptureWorkspace,
  listCaptureDevices,
  revokeCaptureDevice,
  searchCapture,
  setCaptureEnabled,
  setCapturePolicy,
  type CaptureDaysQuery,
  type CapturePolicy,
  type CaptureSearchQuery,
  type CaptureWindowQuery,
} from '../core/rest/platform-client/capture';
import { contract, FRESHNESS } from './query-contracts';
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

/** Pair the asking device to the caller in one of their accounts with Capture on (`accountId` optional when there is one). */
export function useApproveCaptureDevice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: { userCode: string; accountId?: string }) =>
      approveCaptureDeviceGrant(args.userCode, args.accountId),
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

type AccountId = string | null | undefined;

// ── Devices ───────────────────────────────────────────────────────────────────

/**
 * Devices with live status: yours, a member's (`userId`), or the account's
 * (`scope: 'account'`, IAM `capture.read_all`). Polls every 10 s: a device heartbeats every
 * 30 s and reads as offline after 120 s without one.
 */
export function useCaptureDevices(accountId: AccountId, opts: { scope?: 'mine' | 'account'; userId?: string } = {}) {
  return useQuery({
    queryKey: qk.capture.devices(accountId ?? '', opts.scope ?? 'mine', opts.userId ?? null),
    queryFn: () => listCaptureDevices(accountId as string, opts),
    enabled: !!accountId,
    ...contract(FRESHNESS.captureDevices),
  });
}

/** Revoke a device: its token stops working at once. */
export function useRevokeCaptureDevice(accountId: AccountId) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (deviceId: string) => revokeCaptureDevice(accountId as string, deviceId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.capture.account(accountId ?? '') }),
  });
}

// ── Timeline ──────────────────────────────────────────────────────────────────

/** The days with recorded items, newest first, grouped in `query.tz`. */
export function useCaptureDays(accountId: AccountId, query: CaptureDaysQuery = {}) {
  return useQuery({
    queryKey: qk.capture.timelineRead(accountId ?? '', 'days', query),
    queryFn: () => getCaptureDays(accountId as string, query),
    enabled: !!accountId,
    ...contract(FRESHNESS.captureTimeline),
  });
}

/** Activity runs and indexed items of one person in a window. `null` reads nothing. */
export function useCaptureTimeline(accountId: AccountId, query: CaptureWindowQuery | null) {
  return useQuery({
    queryKey: qk.capture.timelineRead(accountId ?? '', 'runs', query),
    queryFn: () => getCaptureTimeline(accountId as string, query ?? undefined),
    enabled: !!accountId && !!query,
    ...contract(FRESHNESS.captureTimeline),
  });
}

/** Frames, actions and audio lines in a window (at most 500 of each). `null` reads nothing. */
export function useCaptureTimelineItems(accountId: AccountId, query: CaptureWindowQuery | null) {
  return useQuery({
    queryKey: qk.capture.timelineRead(accountId ?? '', 'items', query),
    queryFn: () => getCaptureTimelineItems(accountId as string, query ?? undefined),
    enabled: !!accountId && !!query,
    ...contract(FRESHNESS.captureTimeline),
  });
}

/** Full-text search of one person's timeline. `null` (or an empty `q`) reads nothing. */
export function useCaptureSearch(accountId: AccountId, query: CaptureSearchQuery | null) {
  return useQuery({
    queryKey: qk.capture.timelineRead(accountId ?? '', 'search', query),
    queryFn: () => searchCapture(accountId as string, query as CaptureSearchQuery),
    enabled: !!accountId && !!query?.q.trim(),
    ...contract(FRESHNESS.captureTimeline),
  });
}

/** One frame with its on-screen text and a signed URL (5 min) of its video chunk. */
export function useCaptureFrame(accountId: AccountId, frameId: string | null | undefined, opts: { userId?: string } = {}) {
  return useQuery({
    queryKey: qk.capture.timelineRead(accountId ?? '', 'frame', { frameId, userId: opts.userId ?? null }),
    queryFn: () => getCaptureFrame(accountId as string, frameId as string, opts),
    enabled: !!accountId && !!frameId,
    ...contract(FRESHNESS.captureTimeline),
  });
}

/**
 * Signed URLs (5 min) of one indexed item's video or audio. A timeline seeks
 * inside one chunk's video while it scrubs, so it reads this once per chunk.
 */
export function useCaptureChunkMedia(
  accountId: AccountId,
  chunkId: string | null | undefined,
  opts: { userId?: string } = {},
) {
  return useQuery({
    queryKey: qk.capture.timelineRead(accountId ?? '', 'media', { chunkId, userId: opts.userId ?? null }),
    queryFn: () => getCaptureChunkMedia(accountId as string, chunkId as string, opts),
    enabled: !!accountId && !!chunkId,
    ...contract(FRESHNESS.captureTimeline),
    // The URLs expire after 300 s; read them again before that.
    staleTime: 240_000,
    refetchInterval: 240_000,
  });
}

// ── Policy ────────────────────────────────────────────────────────────────────

export function useCapturePolicy(accountId: AccountId) {
  return useQuery({
    queryKey: qk.capture.policy(accountId ?? ''),
    queryFn: () => getCapturePolicy(accountId as string),
    enabled: !!accountId,
    ...contract(FRESHNESS.capturePolicy),
  });
}

/** Replace the account policy and publish it to devices (`capture.manage`). */
export function useSetCapturePolicy(accountId: AccountId) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (policy: CapturePolicy) => setCapturePolicy(accountId as string, policy),
    onSuccess: (record) => queryClient.setQueryData(qk.capture.policy(accountId ?? ''), record),
  });
}

// ── Workspace ─────────────────────────────────────────────────────────────────

/** The account's Capture workspace: on or off, and what IAM lets you do (`can_read_all`, `can_manage`). */
export function useCaptureWorkspace(accountId: AccountId) {
  return useQuery({
    queryKey: qk.capture.workspace(accountId ?? ''),
    queryFn: () => getCaptureWorkspace(accountId as string),
    enabled: !!accountId,
    ...contract(FRESHNESS.captureWorkspace),
  });
}

/** Turn Capture on or off for the account (`capture.manage`). */
export function useSetCaptureEnabled(accountId: AccountId) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (enabled: boolean) => setCaptureEnabled(accountId as string, enabled),
    onSuccess: (workspace) => {
      queryClient.setQueryData(qk.capture.workspace(accountId ?? ''), workspace);
      void queryClient.invalidateQueries({ queryKey: qk.capture.account(accountId ?? '') });
    },
  });
}
