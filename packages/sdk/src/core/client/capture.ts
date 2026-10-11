import * as C from '../rest/platform-client/capture';

/**
 * `kortix.capture.account(id)` — Kortix Capture bound to one account, its
 * tenant. There is no project in Capture.
 */
export function bindAccountCapture(accountId: string) {
  return {
    /** The account switch, and what IAM lets you do. */
    workspace: {
      get: () => C.getCaptureWorkspace(accountId),
      /** IAM `capture.manage`. */
      setEnabled: (enabled: boolean) => C.setCaptureEnabled(accountId, enabled),
    },
    devices: {
      list: (opts?: Parameters<typeof C.listCaptureDevices>[1]) => C.listCaptureDevices(accountId, opts),
      revoke: (deviceId: string) => C.revokeCaptureDevice(accountId, deviceId),
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
  };
}

/** `kortix.capture` — the account handle, the device sign-in approval, and the agent's own reads. */
export const captureClient = {
  // An arrow, not `bindAccountCapture` itself: `typeof bindAccountCapture` names this
  // internal module, and a consumer's declaration emit fails with TS2742.
  account: (accountId: string) => bindAccountCapture(accountId),
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
