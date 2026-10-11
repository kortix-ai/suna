// Kortix Capture — a member's screen, actions and audio as a searchable timeline.
//
// Capture is a standalone product whose tenant is the Kortix account (the
// organization); there is no project anywhere in it. The desktop app writes
// the Kortix Capture format (schema 2) to the account's capture store under
// `orgs/<account_id>/<device_id>/`; Kortix indexes it. Every call here is
// account-scoped and answers 403 `capture_disabled` while Capture is off for
// the account (`setCaptureEnabled`).
//
// Access is Kortix IAM. Every member reads their own devices and timeline.
// `capture.read_all` reads every member's (each read audited); `capture.manage`
// turns Capture on or off, sets the policy and revokes any device. Owner and
// admin hold both by default; `getCaptureWorkspace` says what you hold.
//
// The agent tool reads the person its session acts for through
// `searchMyCapture`, `getMyCaptureTimeline` and `getMyCaptureFrame` — the
// account comes from the token.
//
// The device sign-in itself (RFC 8628) is the desktop app's business; the
// approval half — a signed-in person picking the account — is here
// (`getCaptureDeviceGrant`, `approveCaptureDeviceGrant`, `denyCaptureDeviceGrant`).

import { backendApi } from '../../http/api-client';
import { unwrap } from '../projects-client/shared';

/** What a device is doing now. `offline` = no status for over 120 s. Open for new states. */
export type CaptureLiveState =
  | 'recording'
  | 'paused'
  | 'permission_missing'
  | 'not_recording'
  | 'offline'
  | 'unknown'
  | (string & {});

/** The operator's capture policy, as devices read it from `policy.json`. */
export interface CapturePolicy {
  /** A layer set to false is off on every device, whatever the person chose locally. */
  layers: { screen: boolean; actions: boolean; audio: boolean };
  privacy: { redact_pii: boolean };
  /** `remote_days` 0 keeps indexed data until it is deleted. */
  retention: { local_hours: number; remote_days: number };
  recording: { paused: boolean; paused_until_ms: number | null };
  /** Text the device shows the person being recorded. */
  notice: string;
}

export interface CapturePolicyRecord {
  policy: CapturePolicy;
  /** ISO time of the last change, or null while the default applies. */
  updated_at: string | null;
  updated_by: string | null;
}

export interface CaptureDevice {
  device_id: string;
  /** The member the device records. */
  user_id: string;
  name: string | null;
  os: string | null;
  os_version: string | null;
  arch: string | null;
  app_version: string | null;
  live: {
    state: CaptureLiveState;
    /** The device's last `status.json`, verbatim. */
    status: Record<string, unknown> | null;
    reported_at: string | null;
  };
  last_credentials_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

/** Whose data and when. `day` (UTC `YYYY-MM-DD`) or `from`/`to` (ISO, at most 31 days); default today. */
export interface CaptureWindowQuery {
  day?: string;
  from?: string;
  to?: string;
  /** Another member (IAM `capture.read_all`, audited). Default: the caller. */
  userId?: string;
  deviceId?: string;
}

/** Consecutive frames of one device with the same app and window title. */
export interface CaptureActivityRun {
  device_id: string;
  app: string | null;
  title: string | null;
  url: string | null;
  start_at: string;
  end_at: string;
  frames: number;
}

/** One indexed item: a screen chunk, an audio segment or an action segment. */
export interface CaptureChunk {
  chunk_id: string;
  device_id: string;
  kind: 'chunk' | 'audio' | 'actions';
  start_at: string;
  end_at: string;
  item_count: number;
  encrypted: boolean;
}

export interface CaptureTimeline {
  user_id: string;
  from: string;
  to: string;
  runs: CaptureActivityRun[];
  chunks: CaptureChunk[];
}

export interface CaptureFrame {
  frame_id: string;
  ts: string;
  device_id: string;
  chunk_id: string;
  frame_index: number | null;
  app: string | null;
  bundle_id: string | null;
  title: string | null;
  url: string | null;
  domain: string | null;
  ocr_text: string | null;
  inactive: boolean;
  /** On-screen text boxes, in image pixels (frame detail only). */
  ocr_boxes?: Array<{ text: string; x: number; y: number; w: number; h: number }> | null;
}

export interface CaptureAction {
  action_id: string;
  ts: string;
  device_id: string;
  chunk_id: string;
  kind: string;
  app: string | null;
  window_title: string | null;
  /** e.g. `Click left button at 41%,20%`, `Type "invoice"`. */
  description: string | null;
  target: Record<string, unknown> | null;
  /** Asset name of the action screenshot; pass it to `getCaptureAssetUrl`. */
  screenshot: string | null;
}

export interface CaptureAudioLine {
  line_id: string;
  ts: string;
  end_at: string;
  device_id: string;
  chunk_id: string;
  text: string;
}

export interface CaptureTimelineItems {
  user_id: string;
  from: string;
  to: string;
  /** At most 500 of each, oldest first. */
  frames: CaptureFrame[];
  actions: CaptureAction[];
  audio: CaptureAudioLine[];
}

/** Who and which device, grouped by the day in `tz` (an IANA zone; default UTC). */
export interface CaptureDaysQuery {
  tz?: string;
  /** Another member (IAM `capture.read_all`, audited). Default: the caller. */
  userId?: string;
  deviceId?: string;
}

/** One local day with recorded items. */
export interface CaptureDay {
  /** `YYYY-MM-DD` in the query's time zone. */
  day: string;
  /** The first and the last recorded moment of the day (ISO). */
  start_at: string;
  end_at: string;
  /** Seconds of screen recording, summed over the day's screen chunks. */
  screen_seconds: number;
}

export interface CaptureDays {
  user_id: string;
  tz: string;
  /** Newest first, at most 366. */
  days: CaptureDay[];
}

export type CaptureSearchKind = 'screen' | 'actions' | 'audio';

export interface CaptureSearchQuery extends Omit<CaptureWindowQuery, 'day'> {
  /** Web-search syntax: words, "a phrase", -exclude. */
  q: string;
  kinds?: CaptureSearchKind[];
  /** Only this app (exact name, any case). */
  app?: string;
  /** 1–100, default 20. */
  limit?: number;
  /** `account`: every member (`capture.read_all`; audited as `capture.account_view`). */
  scope?: 'mine' | 'account';
}

export interface CaptureSearchHit {
  kind: CaptureSearchKind;
  /** frame_id, action_id or line_id. */
  id: string;
  ts: string;
  /** Whose recording the hit is. */
  user_id: string;
  device_id: string;
  chunk_id: string;
  app: string | null;
  title: string | null;
  url: string | null;
  snippet: string;
}

export interface CaptureSearchResult {
  /** The person searched; null for an account-wide search (`scope: 'account'`). */
  user_id: string | null;
  q: string;
  hits: CaptureSearchHit[];
}

/** A signed, short-lived (5 min) object URL. */
export interface CaptureSignedUrl {
  url: string;
  expires_at: string;
}

export interface CaptureMediaUrl extends CaptureSignedUrl {
  /** True when the device encrypted the object; Kortix cannot decrypt it. */
  encrypted: boolean;
}

export interface CaptureFrameDetail {
  frame: CaptureFrame;
  /** The frame's video chunk; seek to `offset_ms` (`frame_index` seconds: the chunk video is 1 fps). */
  video: (CaptureMediaUrl & { offset_ms: number }) | null;
  /** The action screenshot nearest the frame on its device (within 30 s): a still of the moment. */
  screenshot?: (CaptureMediaUrl & { name: string; ts: string }) | null;
}

export interface CaptureChunkMedia {
  chunk_id: string;
  kind: CaptureChunk['kind'];
  video: CaptureMediaUrl | null;
  audio: CaptureMediaUrl | null;
}

export interface CaptureDeviceGrant {
  user_code: string;
  status: 'pending' | 'approved' | 'denied' | 'consumed' | 'expired';
  expires_at: string;
  device: {
    name: string | null;
    os: string | null;
    os_version: string | null;
    arch: string | null;
    app_version: string | null;
  };
  /** The account the device was approved into, once approved. */
  account_id: string | null;
  device_id: string | null;
}

/** A pending sign-in, with the caller's accounts that have Capture on (the approval page's picker). */
export interface CaptureDeviceGrantDetail extends CaptureDeviceGrant {
  accounts: { account_id: string; name: string }[];
}

/** The account's Capture workspace as the caller sees it. */
export interface CaptureWorkspace {
  account_id: string;
  enabled: boolean;
  /** IAM `capture.read_all`: you read every member's devices and timeline (each read audited). */
  can_read_all: boolean;
  /** IAM `capture.manage`: you turn Capture on or off, set the policy and revoke any device. */
  can_manage: boolean;
  updated_at: string | null;
}

const base = (accountId: string) => `/accounts/${accountId}/capture`;

function captureQuery(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `?${query}` : '';
}

const searchParams = (query: CaptureSearchQuery) =>
  captureQuery({
    q: query.q,
    kinds: query.kinds?.join(','),
    app: query.app,
    limit: query.limit,
    from: query.from,
    to: query.to,
    user_id: query.userId,
    device_id: query.deviceId,
    scope: query.scope,
  });

const windowParams = (query: CaptureWindowQuery = {}) => ({
  day: query.day,
  from: query.from,
  to: query.to,
  user_id: query.userId,
  device_id: query.deviceId,
});

// ── Devices ───────────────────────────────────────────────────────────────────

/** Your devices with live status; a member's (`userId`) or the account's (`scope: 'account'`) with `capture.read_all`. */
export async function listCaptureDevices(accountId: string, opts: { userId?: string; scope?: 'mine' | 'account' } = {}) {
  return unwrap(
    await backendApi.get<{ devices: CaptureDevice[] }>(
      `${base(accountId)}/devices${captureQuery({ user_id: opts.userId, scope: opts.scope })}`,
    ),
  );
}

/** Revoke a device: its token stops working at once. Your own device, or any device with `capture.manage`. */
export async function revokeCaptureDevice(accountId: string, deviceId: string) {
  return unwrap(await backendApi.delete<CaptureDevice>(`${base(accountId)}/devices/${deviceId}`));
}

// ── Policy ────────────────────────────────────────────────────────────────────

export async function getCapturePolicy(accountId: string) {
  return unwrap(await backendApi.get<CapturePolicyRecord>(`${base(accountId)}/policy`));
}

/** Replace the account policy and publish it to devices (`capture.manage`). */
export async function setCapturePolicy(accountId: string, policy: CapturePolicy) {
  return unwrap(await backendApi.put<CapturePolicyRecord>(`${base(accountId)}/policy`, { policy }));
}

// ── Timeline ──────────────────────────────────────────────────────────────────

/** Activity runs, indexed items and ranges of one person for a day or a time span. */
export async function getCaptureTimeline(accountId: string, query: CaptureWindowQuery = {}) {
  return unwrap(
    await backendApi.get<CaptureTimeline>(`${base(accountId)}/timeline${captureQuery(windowParams(query))}`),
  );
}

/** Frames, actions and audio lines of one person in a time span. */
export async function getCaptureTimelineItems(accountId: string, query: CaptureWindowQuery = {}) {
  return unwrap(
    await backendApi.get<CaptureTimelineItems>(`${base(accountId)}/timeline/items${captureQuery(windowParams(query))}`),
  );
}

/** The days with recorded items, newest first: the day picker of a timeline. */
export async function getCaptureDays(accountId: string, query: CaptureDaysQuery = {}) {
  return unwrap(
    await backendApi.get<CaptureDays>(
      `${base(accountId)}/days${captureQuery({ tz: query.tz, user_id: query.userId, device_id: query.deviceId })}`,
    ),
  );
}

/** Full-text search across screen (app, window, URL, on-screen text), actions and audio. */
export async function searchCapture(accountId: string, query: CaptureSearchQuery) {
  return unwrap(await backendApi.get<CaptureSearchResult>(`${base(accountId)}/search${searchParams(query)}`));
}

// ── Media ─────────────────────────────────────────────────────────────────────

/** One frame with its full on-screen text and a signed URL of its video chunk. */
export async function getCaptureFrame(accountId: string, frameId: string, opts: { userId?: string } = {}) {
  return unwrap(
    await backendApi.get<CaptureFrameDetail>(
      `${base(accountId)}/frames/${frameId}${captureQuery({ user_id: opts.userId })}`,
    ),
  );
}

/** Signed URLs of an indexed item's video or audio. */
export async function getCaptureChunkMedia(accountId: string, chunkId: string, opts: { userId?: string } = {}) {
  return unwrap(
    await backendApi.get<CaptureChunkMedia>(
      `${base(accountId)}/chunks/${chunkId}/media${captureQuery({ user_id: opts.userId })}`,
    ),
  );
}

/** A signed URL of one content-addressed asset (an action screenshot). */
export async function getCaptureAssetUrl(accountId: string, deviceId: string, name: string) {
  return unwrap(
    await backendApi.get<CaptureSignedUrl>(`${base(accountId)}/devices/${deviceId}/assets/${encodeURIComponent(name)}`),
  );
}

// ── Device sign-in approval ───────────────────────────────────────────────────

/** The device asking to sign in with this user code (the approval page). */
export async function getCaptureDeviceGrant(userCode: string) {
  return unwrap(await backendApi.get<CaptureDeviceGrantDetail>(`/capture/device/grants/${encodeURIComponent(userCode)}`));
}

/**
 * Approve a device sign-in into one of your accounts. Without `accountId` the
 * API picks your one account with Capture on (400 `capture_account_required`
 * when you have several).
 */
export async function approveCaptureDeviceGrant(userCode: string, accountId?: string) {
  return unwrap(
    await backendApi.post<CaptureDeviceGrant>(
      `/capture/device/grants/${encodeURIComponent(userCode)}/approve`,
      accountId ? { account_id: accountId } : {},
    ),
  );
}

export async function denyCaptureDeviceGrant(userCode: string) {
  return unwrap(
    await backendApi.post<CaptureDeviceGrant>(`/capture/device/grants/${encodeURIComponent(userCode)}/deny`, {}),
  );
}

// ── Workspace (the account switch) ───────────────────────────────────────────

/** The account's Capture workspace: on or off, and what IAM lets you do (`can_read_all`, `can_manage`). */
export async function getCaptureWorkspace(accountId: string) {
  return unwrap(await backendApi.get<CaptureWorkspace>(base(accountId)));
}

/** Turn Capture on or off for the account (`capture.manage`). */
export async function setCaptureEnabled(accountId: string, enabled: boolean) {
  return unwrap(await backendApi.patch<CaptureWorkspace>(base(accountId), { enabled }));
}

// ── The agent tool (account from the token) ──────────────────────────────────

/** Search the timeline of the person your token acts for (an agent's private session, or you). */
export async function searchMyCapture(query: CaptureSearchQuery) {
  return unwrap(await backendApi.get<CaptureSearchResult>(`/capture/me/search${searchParams(query)}`));
}

/** The timeline of the person your token acts for. */
export async function getMyCaptureTimeline(query: Omit<CaptureWindowQuery, 'userId'> = {}) {
  return unwrap(await backendApi.get<CaptureTimeline>(`/capture/me/timeline${captureQuery(windowParams(query))}`));
}

/** One frame of the person your token acts for, with its on-screen text and video URL. */
export async function getMyCaptureFrame(frameId: string) {
  return unwrap(await backendApi.get<CaptureFrameDetail>(`/capture/me/frames/${frameId}`));
}
