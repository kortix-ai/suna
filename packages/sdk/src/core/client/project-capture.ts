import * as P from '../rest/projects-client';

/** `kortix.project(id).capture` — Kortix Capture, bound to one project. */
export function bindProjectCapture(projectId: string) {
  return {
    capture: {
      devices: {
        list: (opts?: Parameters<typeof P.listCaptureDevices>[1]) => P.listCaptureDevices(projectId, opts),
        revoke: (deviceId: string) => P.revokeCaptureDevice(projectId, deviceId),
        sync: (deviceId: string) => P.syncCaptureDevice(projectId, deviceId),
        setPolicy: (deviceId: string, policy: P.CapturePolicy | null) =>
          P.setCaptureDevicePolicy(projectId, deviceId, policy),
        assetUrl: (deviceId: string, name: string) => P.getCaptureAssetUrl(projectId, deviceId, name),
      },
      policy: {
        get: () => P.getCapturePolicy(projectId),
        set: (policy: P.CapturePolicy) => P.setCapturePolicy(projectId, policy),
      },
      timeline: {
        get: (query?: P.CaptureWindowQuery) => P.getCaptureTimeline(projectId, query),
        items: (query?: P.CaptureWindowQuery) => P.getCaptureTimelineItems(projectId, query),
        /** The days with recorded items, newest first, grouped in `tz`. */
        days: (query?: P.CaptureDaysQuery) => P.getCaptureDays(projectId, query),
      },
      search: (query: P.CaptureSearchQuery) => P.searchCapture(projectId, query),
      frame: (frameId: string, opts?: { userId?: string }) => P.getCaptureFrame(projectId, frameId, opts),
      media: (chunkId: string, opts?: { userId?: string }) => P.getCaptureChunkMedia(projectId, chunkId, opts),
      ranges: {
        list: (query?: P.CaptureWindowQuery) => P.listCaptureRanges(projectId, query),
        save: (input: P.SaveCaptureRangeInput) => P.saveCaptureRange(projectId, input),
        get: (rangeId: string) => P.getCaptureRange(projectId, rangeId),
        process: (rangeId: string) => P.processCaptureRange(projectId, rangeId),
      },
      /** Managers: per-member active time, time per app, ranges, devices. */
      people: (query?: Parameters<typeof P.getCapturePeople>[1]) => P.getCapturePeople(projectId, query),
    },
  };
}
