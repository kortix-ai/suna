'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  approveCaptureDeviceGrant,
  getCaptureWorkspace,
  listCaptureMembers,
  setCaptureEnabled,
  setCaptureMemberRole,
  type CaptureRole,
  denyCaptureDeviceGrant,
  getCaptureChunkMedia,
  getCaptureDays,
  getCaptureDeviceGrant,
  getCaptureFrame,
  getCapturePeople,
  getCapturePolicy,
  getCaptureRange,
  getCaptureTimeline,
  getCaptureTimelineItems,
  listCaptureDevices,
  listCaptureRanges,
  processCaptureRange,
  revokeCaptureDevice,
  saveCaptureRange,
  searchCapture,
  setCapturePolicy,
  syncCaptureDevice,
  type CaptureDaysQuery,
  type CapturePolicy,
  type CaptureRangeDetail,
  type CaptureSearchQuery,
  type CaptureWindowQuery,
  type SaveCaptureRangeInput,
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
 * (`scope: 'account'`, Capture admins and viewers). Polls every 10 s: a device heartbeats every
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

/** Read a device's status and index now ("Sync now"); the timeline refreshes with it. */
export function useSyncCaptureDevice(accountId: AccountId) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (deviceId: string) => syncCaptureDevice(accountId as string, deviceId),
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

/** Activity runs, indexed items and ranges of one person in a window. `null` reads nothing. */
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

// ── Ranges ────────────────────────────────────────────────────────────────────

/** One person's ranges (detected and saved) in a window. `null` reads nothing. */
export function useCaptureRanges(accountId: AccountId, query: CaptureWindowQuery | null) {
  return useQuery({
    queryKey: qk.capture.timelineRead(accountId ?? '', 'ranges', query),
    queryFn: () => listCaptureRanges(accountId as string, query ?? undefined),
    enabled: !!accountId && !!query,
    ...contract(FRESHNESS.captureTimeline),
  });
}

const rangeBusy = (range: CaptureRangeDetail | undefined) =>
  !!range &&
  (range.status === 'closed' ||
    range.status === 'processing' ||
    range.outputs.some((output) => output.status === 'running'));

/** One range with its outputs. Polls every 5 s while its pipelines are queued or running. */
export function useCaptureRange(accountId: AccountId, rangeId: string | null | undefined) {
  return useQuery({
    queryKey: qk.capture.range(accountId ?? '', rangeId ?? ''),
    queryFn: () => getCaptureRange(accountId as string, rangeId as string),
    enabled: !!accountId && !!rangeId,
    ...contract(FRESHNESS.captureTimeline),
    refetchInterval: (query) => (rangeBusy(query.state.data) ? 5_000 : false),
  });
}

/** Save a span of your own timeline as a range; its pipelines start at once. */
export function useSaveCaptureRange(accountId: AccountId) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SaveCaptureRangeInput) => saveCaptureRange(accountId as string, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.capture.timeline(accountId ?? '') }),
  });
}

/** Run a range's pipelines again. */
export function useProcessCaptureRange(accountId: AccountId) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (rangeId: string) => processCaptureRange(accountId as string, rangeId),
    onSuccess: (_result, rangeId) => {
      void queryClient.invalidateQueries({ queryKey: qk.capture.range(accountId ?? '', rangeId) });
      void queryClient.invalidateQueries({ queryKey: qk.capture.timeline(accountId ?? '') });
    },
  });
}

// ── Policy and people (admins, viewers) ────────────────────────────────────────────

export function useCapturePolicy(accountId: AccountId) {
  return useQuery({
    queryKey: qk.capture.policy(accountId ?? ''),
    queryFn: () => getCapturePolicy(accountId as string),
    enabled: !!accountId,
    ...contract(FRESHNESS.capturePolicy),
  });
}

/** Replace the account policy and publish it to devices. Capture admins only. */
export function useSetCapturePolicy(accountId: AccountId) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (policy: CapturePolicy) => setCapturePolicy(accountId as string, policy),
    onSuccess: (record) => queryClient.setQueryData(qk.capture.policy(accountId ?? ''), record),
  });
}

/** Per member: active time, time per app, ranges, devices. Capture admins and viewers; audited. `null` reads nothing. */
export function useCapturePeople(
  accountId: AccountId,
  query: Omit<CaptureWindowQuery, 'userId' | 'deviceId'> | null,
) {
  return useQuery({
    queryKey: qk.capture.people(accountId ?? '', query),
    queryFn: () => getCapturePeople(accountId as string, query ?? undefined),
    enabled: !!accountId && !!query,
    ...contract(FRESHNESS.capturePeople),
  });
}

// ── Workspace and roles ───────────────────────────────────────────────────────

/** The account's Capture workspace: on or off, your Capture role, whether you may turn it on. */
export function useCaptureWorkspace(accountId: AccountId) {
  return useQuery({
    queryKey: qk.capture.workspace(accountId ?? ''),
    queryFn: () => getCaptureWorkspace(accountId as string),
    enabled: !!accountId,
    ...contract(FRESHNESS.captureWorkspace),
  });
}

/** Turn Capture on or off for the account (account owners and admins). */
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

/** Every account member with their Capture role (Capture admins). */
export function useCaptureMembers(accountId: AccountId) {
  return useQuery({
    queryKey: qk.capture.members(accountId ?? ''),
    queryFn: () => listCaptureMembers(accountId as string),
    enabled: !!accountId,
    ...contract(FRESHNESS.captureMembers),
  });
}

/** Set a member's Capture role, or clear it (null) back to the account-role default (Capture admins). */
export function useSetCaptureMemberRole(accountId: AccountId) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: { userId: string; role: CaptureRole | null }) =>
      setCaptureMemberRole(accountId as string, args.userId, args.role),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.capture.members(accountId ?? '') }),
  });
}
