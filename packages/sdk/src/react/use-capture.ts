'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  approveCaptureDeviceGrant,
  denyCaptureDeviceGrant,
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
} from '../core/rest/projects-client';
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

type ProjectId = string | null | undefined;

// ── Devices ───────────────────────────────────────────────────────────────────

/**
 * Devices with live status: yours, a member's (`userId`), or the project's
 * (`scope: 'project'`, managers). Polls every 10 s: a device heartbeats every
 * 30 s and reads as offline after 120 s without one.
 */
export function useCaptureDevices(projectId: ProjectId, opts: { scope?: 'mine' | 'project'; userId?: string } = {}) {
  return useQuery({
    queryKey: qk.project.captureDevices(projectId ?? '', opts.scope ?? 'mine', opts.userId ?? null),
    queryFn: () => listCaptureDevices(projectId as string, opts),
    enabled: !!projectId,
    ...contract(FRESHNESS.captureDevices),
  });
}

/** Revoke a device: its token stops working at once. */
export function useRevokeCaptureDevice(projectId: ProjectId) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (deviceId: string) => revokeCaptureDevice(projectId as string, deviceId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.project.capture(projectId ?? '') }),
  });
}

/** Read a device's status and index now ("Sync now"); the timeline refreshes with it. */
export function useSyncCaptureDevice(projectId: ProjectId) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (deviceId: string) => syncCaptureDevice(projectId as string, deviceId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.project.capture(projectId ?? '') }),
  });
}

// ── Timeline ──────────────────────────────────────────────────────────────────

/** The days with recorded items, newest first, grouped in `query.tz`. */
export function useCaptureDays(projectId: ProjectId, query: CaptureDaysQuery = {}) {
  return useQuery({
    queryKey: qk.project.captureTimelineRead(projectId ?? '', 'days', query),
    queryFn: () => getCaptureDays(projectId as string, query),
    enabled: !!projectId,
    ...contract(FRESHNESS.captureTimeline),
  });
}

/** Activity runs, indexed items and ranges of one person in a window. `null` reads nothing. */
export function useCaptureTimeline(projectId: ProjectId, query: CaptureWindowQuery | null) {
  return useQuery({
    queryKey: qk.project.captureTimelineRead(projectId ?? '', 'runs', query),
    queryFn: () => getCaptureTimeline(projectId as string, query ?? undefined),
    enabled: !!projectId && !!query,
    ...contract(FRESHNESS.captureTimeline),
  });
}

/** Frames, actions and audio lines in a window (at most 500 of each). `null` reads nothing. */
export function useCaptureTimelineItems(projectId: ProjectId, query: CaptureWindowQuery | null) {
  return useQuery({
    queryKey: qk.project.captureTimelineRead(projectId ?? '', 'items', query),
    queryFn: () => getCaptureTimelineItems(projectId as string, query ?? undefined),
    enabled: !!projectId && !!query,
    ...contract(FRESHNESS.captureTimeline),
  });
}

/** Full-text search of one person's timeline. `null` (or an empty `q`) reads nothing. */
export function useCaptureSearch(projectId: ProjectId, query: CaptureSearchQuery | null) {
  return useQuery({
    queryKey: qk.project.captureTimelineRead(projectId ?? '', 'search', query),
    queryFn: () => searchCapture(projectId as string, query as CaptureSearchQuery),
    enabled: !!projectId && !!query?.q.trim(),
    ...contract(FRESHNESS.captureTimeline),
  });
}

/** One frame with its on-screen text and a signed URL (5 min) of its video chunk. */
export function useCaptureFrame(projectId: ProjectId, frameId: string | null | undefined, opts: { userId?: string } = {}) {
  return useQuery({
    queryKey: qk.project.captureTimelineRead(projectId ?? '', 'frame', { frameId, userId: opts.userId ?? null }),
    queryFn: () => getCaptureFrame(projectId as string, frameId as string, opts),
    enabled: !!projectId && !!frameId,
    ...contract(FRESHNESS.captureTimeline),
  });
}

// ── Ranges ────────────────────────────────────────────────────────────────────

/** One person's ranges (detected and saved) in a window. `null` reads nothing. */
export function useCaptureRanges(projectId: ProjectId, query: CaptureWindowQuery | null) {
  return useQuery({
    queryKey: qk.project.captureTimelineRead(projectId ?? '', 'ranges', query),
    queryFn: () => listCaptureRanges(projectId as string, query ?? undefined),
    enabled: !!projectId && !!query,
    ...contract(FRESHNESS.captureTimeline),
  });
}

const rangeBusy = (range: CaptureRangeDetail | undefined) =>
  !!range &&
  (range.status === 'closed' ||
    range.status === 'processing' ||
    range.outputs.some((output) => output.status === 'running'));

/** One range with its outputs. Polls every 5 s while its pipelines are queued or running. */
export function useCaptureRange(projectId: ProjectId, rangeId: string | null | undefined) {
  return useQuery({
    queryKey: qk.project.captureRange(projectId ?? '', rangeId ?? ''),
    queryFn: () => getCaptureRange(projectId as string, rangeId as string),
    enabled: !!projectId && !!rangeId,
    ...contract(FRESHNESS.captureTimeline),
    refetchInterval: (query) => (rangeBusy(query.state.data) ? 5_000 : false),
  });
}

/** Save a span of your own timeline as a range; its pipelines start at once. */
export function useSaveCaptureRange(projectId: ProjectId) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SaveCaptureRangeInput) => saveCaptureRange(projectId as string, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.project.captureTimeline(projectId ?? '') }),
  });
}

/** Run a range's pipelines again. */
export function useProcessCaptureRange(projectId: ProjectId) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (rangeId: string) => processCaptureRange(projectId as string, rangeId),
    onSuccess: (_result, rangeId) => {
      void queryClient.invalidateQueries({ queryKey: qk.project.captureRange(projectId ?? '', rangeId) });
      void queryClient.invalidateQueries({ queryKey: qk.project.captureTimeline(projectId ?? '') });
    },
  });
}

// ── Policy and people (managers) ──────────────────────────────────────────────

export function useCapturePolicy(projectId: ProjectId) {
  return useQuery({
    queryKey: qk.project.capturePolicy(projectId ?? ''),
    queryFn: () => getCapturePolicy(projectId as string),
    enabled: !!projectId,
    ...contract(FRESHNESS.capturePolicy),
  });
}

/** Replace the project policy and publish it to devices. Managers only. */
export function useSetCapturePolicy(projectId: ProjectId) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (policy: CapturePolicy) => setCapturePolicy(projectId as string, policy),
    onSuccess: (record) => queryClient.setQueryData(qk.project.capturePolicy(projectId ?? ''), record),
  });
}

/** Per member: active time, time per app, ranges, devices. Managers only; audited. `null` reads nothing. */
export function useCapturePeople(
  projectId: ProjectId,
  query: Omit<CaptureWindowQuery, 'userId' | 'deviceId'> | null,
) {
  return useQuery({
    queryKey: qk.project.capturePeople(projectId ?? '', query),
    queryFn: () => getCapturePeople(projectId as string, query ?? undefined),
    enabled: !!projectId && !!query,
    ...contract(FRESHNESS.capturePeople),
  });
}
