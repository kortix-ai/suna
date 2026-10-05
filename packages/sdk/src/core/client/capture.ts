import * as C from '../rest/platform-client/capture';

/**
 * `kortix.capture.account(id)` — Kortix Capture bound to one account, its
 * tenant. There is no project in Capture.
 */
export function bindAccountCapture(accountId: string) {
  return {
    /** The account switch and your role. */
    workspace: {
      get: () => C.getCaptureWorkspace(accountId),
      /** Account owners and admins. */
      setEnabled: (enabled: boolean) => C.setCaptureEnabled(accountId, enabled),
    },
    /** Capture roles (Capture admins). */
    members: {
      list: () => C.listCaptureMembers(accountId),
      set: (userId: string, role: C.CaptureRole | null) => C.setCaptureMemberRole(accountId, userId, role),
    },
    devices: {
      list: (opts?: Parameters<typeof C.listCaptureDevices>[1]) => C.listCaptureDevices(accountId, opts),
      revoke: (deviceId: string) => C.revokeCaptureDevice(accountId, deviceId),
      sync: (deviceId: string) => C.syncCaptureDevice(accountId, deviceId),
      setPolicy: (deviceId: string, policy: C.CapturePolicy | null) => C.setCaptureDevicePolicy(accountId, deviceId, policy),
      assetUrl: (deviceId: string, name: string) => C.getCaptureAssetUrl(accountId, deviceId, name),
    },
    policy: {
      get: () => C.getCapturePolicy(accountId),
      set: (policy: C.CapturePolicy) => C.setCapturePolicy(accountId, policy),
    },
    timeline: {
      get: (query?: C.CaptureWindowQuery) => C.getCaptureTimeline(accountId, query),
      items: (query?: C.CaptureWindowQuery) => C.getCaptureTimelineItems(accountId, query),
      /** The days with recorded items, newest first, grouped in `tz`. */
      days: (query?: C.CaptureDaysQuery) => C.getCaptureDays(accountId, query),
    },
    search: (query: C.CaptureSearchQuery) => C.searchCapture(accountId, query),
    frame: (frameId: string, opts?: { userId?: string }) => C.getCaptureFrame(accountId, frameId, opts),
    media: (chunkId: string, opts?: { userId?: string }) => C.getCaptureChunkMedia(accountId, chunkId, opts),
    ranges: {
      list: (query?: C.CaptureWindowQuery) => C.listCaptureRanges(accountId, query),
      save: (input: C.SaveCaptureRangeInput) => C.saveCaptureRange(accountId, input),
      get: (rangeId: string) => C.getCaptureRange(accountId, rangeId),
      process: (rangeId: string) => C.processCaptureRange(accountId, rangeId),
    },
    /** Admins and viewers: per-member active time, time per app, ranges, devices. */
    people: (query?: Parameters<typeof C.getCapturePeople>[1]) => C.getCapturePeople(accountId, query),
  };
}

/** `kortix.capture` — the account handle, the device sign-in approval, and the agent's own reads. */
export const captureClient = {
  account: bindAccountCapture,
  deviceGrant: C.getCaptureDeviceGrant,
  approveDevice: C.approveCaptureDeviceGrant,
  denyDevice: C.denyCaptureDeviceGrant,
  /** The person your token acts for (an agent's private session, or you); the account comes from the token. */
  me: {
    search: C.searchMyCapture,
    timeline: C.getMyCaptureTimeline,
    frame: C.getMyCaptureFrame,
  },
};
