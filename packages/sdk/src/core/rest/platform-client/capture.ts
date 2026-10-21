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
import type { CaptureExclusionGroup, CaptureLayer, CaptureMaxHeight } from '../../capture/rules';

export * from '../../capture/rules';

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
  privacy: {
    redact_pii: boolean;
    /** Apps (macOS bundle ids, Windows/Linux executables) no device of the account records. */
    excluded_bundle_ids: string[];
    /** Websites no device records; host names, `www.` and paths stripped. */
    excluded_domains: string[];
    /** Built-in categories every device excludes: `password_managers`, `messaging`, `banking`. */
    exclusion_groups: CaptureExclusionGroup[];
    /** Private browser tabs and windows are never recorded. */
    exclude_private_browsing: boolean;
    /**
     * Record only what is included: a device records a window only when its app is in
     * `included_bundle_ids` or its website is in `included_domains`. Members can add to both
     * lists on their computer but cannot turn this off. Exclusions still win. Absent: false.
     */
    record_only_included?: boolean;
    /** Apps recorded in full while `record_only_included` is on. */
    included_bundle_ids?: string[];
    /** Websites recorded, in any browser, while `record_only_included` is on. */
    included_domains?: string[];
    /**
     * False: members cannot add their own included apps and websites (only the
     * organization's are recorded). Their own exclusions always apply. Absent: true.
     */
    member_inclusions?: boolean;
  };
  /** `remote_days` 0 keeps indexed data until it is deleted. */
  retention: { local_hours: number; remote_days: number };
  recording: {
    paused: boolean;
    paused_until_ms: number | null;
    /**
     * One screen frame every this many milliseconds, 500–10000, on every device
     * (`CAPTURE_FRAME_INTERVALS_MS` lists the choices). Null or absent: the
     * device default, `CAPTURE_DEVICE_DEFAULTS.intervalMs`.
     */
    interval_ms?: number | null;
    /** The frame height in pixels, at most. Null or absent: `CAPTURE_DEVICE_DEFAULTS.maxHeight`. */
    max_height?: CaptureMaxHeight | null;
  };
  /** Text the device shows the person being recorded. */
  notice: string;
  /**
   * Experimental surfaces. `privacy_controls` shows the exclusions and masking in
   * Kortix and in the app; hiding them never changes what applies. Absent: all off.
   */
  experimental?: { privacy_controls: boolean };
}

export interface CapturePolicyRecord {
  policy: CapturePolicy;
  /** ISO time of the last change, or null while the default applies. */
  updated_at: string | null;
  updated_by: string | null;
}

/** The deployment-managed store (the default). */
export interface CaptureStorageKortix {
  mode: 'kortix';
}

/**
 * The account's own S3-compatible bucket ("bring your own storage"). Give
 * exactly one credential form: `role_arn` (STS; devices get per-device scoped
 * credentials) OR `access_key_id` + `secret_access_key` (account-wide; static
 * keys cannot be scoped per device). Switching stores does not migrate old
 * recordings — they stay in the previous store.
 */
export interface CaptureStorageS3Input {
  mode: 's3';
  /** Empty = the AWS regional endpoint for `region`. */
  endpoint?: string;
  region: string;
  bucket: string;
  /** Path-style URLs (MinIO and most self-hosted S3); false on AWS. */
  force_path_style?: boolean;
  /** An IAM role Kortix assumes (STS). Preferred: enables per-device scoped credentials. */
  role_arn?: string;
  access_key_id?: string;
  /** Plaintext on write; stored encrypted and never returned. */
  secret_access_key?: string;
}

/** Where to keep the account's recordings. */
export type CaptureStorageInput = CaptureStorageKortix | CaptureStorageS3Input;

/** The redacted storage config a client reads. The secret is never returned. */
export type CaptureStorageView =
  | CaptureStorageKortix
  | {
      mode: 's3';
      endpoint: string;
      region: string;
      bucket: string;
      force_path_style: boolean;
      role_arn: string;
      access_key_id: string;
      /** A static secret is stored (its value is never returned). */
      has_secret: boolean;
      /** Devices get per-device scoped credentials (role mode); false for static keys (account-wide). */
      per_device_scoped: boolean;
    };

/** One physical display of a device. Points in the device's global desktop space (top-left origin). */
export interface CaptureDisplay {
  /** The OS display id; stable while the display stays connected. */
  id: number;
  name: string | null;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Pixels per point; null when the device did not say. */
  scale: number | null;
  /** The main display (menu bar, dock). */
  main: boolean;
}

/** Which display held the focused window from `start_at` to `end_at`. */
export interface CaptureFocusSpan {
  device_id: string;
  display_id: number;
  start_at: string;
  end_at: string;
}

/** Why a computer is not healthy, most urgent first. */
export type CaptureHealthReason =
  | 'offline'
  | 'stalled'
  | 'error'
  | 'never_reported'
  | 'unseen'
  | 'permission_missing'
  | 'paused'
  | 'sync_error'
  | 'backlog'
  | 'behind_version';

/**
 * Fleet health of one computer, from its last status report. `not_recording`:
 * it should record and does not (silent 30 min or more, or no frame for 5 min
 * of awake time). `attention`: it records or will, but a person should look.
 * `idle` is a healthy computer that is locked, inactive or asleep.
 */
export interface CaptureDeviceHealth {
  state: 'healthy' | 'attention' | 'not_recording';
  idle: boolean;
  reasons: CaptureHealthReason[];
  /** When the not-recording spell began; null unless `state` is `not_recording`. */
  since: string | null;
  /** The newest published Capture version, only when this computer is behind it. */
  latest_version: string | null;
}

/** Computers per bucket; every computer counts once. */
export interface CaptureHealthSummary {
  recording: number;
  idle: number;
  attention: number;
  not_recording: number;
  /** The newest published Capture version; null when unknown. */
  latest_version: string | null;
}

export type CaptureHealthBucket = 'recording' | 'idle' | 'attention' | 'not_recording';

/** The summary bucket a computer counts in. */
export function captureHealthBucket(device: Pick<CaptureDevice, 'health'>): CaptureHealthBucket {
  const { state, idle } = device.health;
  if (state === 'healthy') return idle ? 'idle' : 'recording';
  return state;
}

export interface CaptureDevice {
  device_id: string;
  /** The member the device records; null: an IT-enrolled computer linked to no one yet (`linkCaptureDevice`). */
  user_id: string | null;
  name: string | null;
  os: string | null;
  os_version: string | null;
  arch: string | null;
  app_version: string | null;
  /** The displays the device reported, in its layout; empty from a one-display device. */
  displays: CaptureDisplay[];
  live: {
    state: CaptureLiveState;
    /** The device's last `status.json`, verbatim. */
    status: Record<string, unknown> | null;
    reported_at: string | null;
  };
  last_credentials_at: string | null;
  revoked_at: string | null;
  health: CaptureDeviceHealth;
  /** The enrollment token the device enrolled with (an IT rollout); null when a person signed it in. */
  enrollment_token_id?: string | null;
  created_at: string;
}

/**
 * An IT rollout secret: a computer that presents it enrolls itself as the
 * person signed in to Windows, with no browser sign-in. The secret itself is
 * in the create answer only ({@link CaptureEnrollmentTokenSecret}).
 */
export interface CaptureEnrollmentToken {
  token_id: string;
  name: string;
  /** The first characters of the secret, to recognise it. */
  token_prefix: string;
  state: 'active' | 'revoked' | 'expired';
  /** Windows sign-in domains a person must use; empty: any member. */
  email_domains: string[];
  /** At most this many computers; null: no limit. */
  max_devices: number | null;
  /** Computers that enrolled or wait with this token (a denied one not counted). */
  device_count: number;
  /** Every new computer waits for an admin, also when its person is a member. */
  require_approval: boolean;
  /** Every computer the token enrolls is linked to this member; null: matched by the sign-in email. */
  user_id: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
  created_by: string;
  created_at: string;
}

export interface CaptureEnrollmentTokenSecret extends CaptureEnrollmentToken {
  /** `kortix_enr_…`: shown once. IT writes it to the computers. */
  token: string;
}

export interface CaptureEnrollmentTokenInput {
  name: string;
  email_domains?: string[];
  max_devices?: number | null;
  require_approval?: boolean;
  /** Default 30; null: never expires. */
  expires_in_days?: number | null;
  /** Link every computer this token enrolls to this member (a personal install). Absent: matched by the sign-in email. */
  user_id?: string | null;
}

export type CaptureEnrollmentStatus = 'pending' | 'approved' | 'denied' | 'enrolled';

/** One computer + Windows person that presented an enrollment token. */
export interface CaptureEnrollment {
  enrollment_id: string;
  token_id: string;
  token_name: string | null;
  status: CaptureEnrollmentStatus;
  /** Why a pending computer waits: the token approves each computer, or an admin revoked it. */
  reason: 'approval_required' | null;
  /** The Windows UPN. */
  principal_name: string | null;
  /** The Windows login name (`DOMAIN\\user`). */
  account_name: string | null;
  device: { name: string | null; os: string | null; os_version: string | null; arch: string | null; app_version: string | null };
  /** The member the computer records for (matched, approved or linked); null: linked to no one. */
  user_id: string | null;
  device_id: string | null;
  decided_by: string | null;
  decided_at: string | null;
  created_at: string;
  last_seen_at: string;
}

/** Whose data and when. `day` (UTC `YYYY-MM-DD`) or `from`/`to` (ISO, at most 31 days); default today. */
export interface CaptureWindowQuery {
  day?: string;
  from?: string;
  to?: string;
  /** Another member (IAM `capture.read_all`, audited). Default: the caller. */
  userId?: string;
  deviceId?: string;
  /**
   * One display's screen items, runs and frames. Default: the display that held
   * the focused window at each moment. `'all'` (items only): every display's frames.
   */
  displayId?: number | 'all';
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
  /** The display a screen item recorded (one item per display); null for audio, actions and one-display devices. */
  display_id: number | null;
  display: CaptureDisplay | null;
}

export interface CaptureTimeline {
  user_id: string;
  from: string;
  to: string;
  /** Every display with screen items in the window, main first, whatever `displayId` asked for. */
  displays: CaptureDisplay[];
  /** Which display held the focused window, over time: the active display at any moment. */
  focus: CaptureFocusSpan[];
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
  /** The display the frame shows; null from a one-display device. */
  display_id: number | null;
  /** The display held the focused window when the frame was taken. */
  focused: boolean;
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

export type CaptureSearchKind = CaptureLayer;

/** `day` keeps the search to one UTC day and wins over `from`/`to`; without
 * either, search covers all of time. Search does not filter by display. */
export interface CaptureSearchQuery extends Omit<CaptureWindowQuery, 'displayId'> {
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
  /** The display a screen hit shows; null for actions, audio and one-display devices. */
  display_id: number | null;
  display_name: string | null;
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
  /** The frame's display; null from a one-display device. */
  display?: CaptureDisplay | null;
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
    day: query.day,
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
  display_id: query.displayId,
});

// ── Devices ───────────────────────────────────────────────────────────────────

/** Your devices with live status; a member's (`userId`) or the account's (`scope: 'account'`) with `capture.read_all`. */
export async function listCaptureDevices(accountId: string, opts: { userId?: string; scope?: 'mine' | 'account' } = {}) {
  return unwrap(
    await backendApi.get<{ devices: CaptureDevice[]; health: CaptureHealthSummary }>(
      `${base(accountId)}/devices${captureQuery({ user_id: opts.userId, scope: opts.scope })}`,
    ),
  );
}

/** Revoke a device: its token stops working at once. Your own device, or any device with `capture.manage`. */
export async function revokeCaptureDevice(accountId: string, deviceId: string) {
  return unwrap(await backendApi.delete<CaptureDevice>(`${base(accountId)}/devices/${deviceId}`));
}

/**
 * Link a device to a member, or unlink it (`null`) (`capture.manage`). What it
 * recorded linked to no one moves to the member within minutes; what it
 * recorded for an earlier member stays theirs.
 */
export async function linkCaptureDevice(accountId: string, deviceId: string, userId: string | null) {
  return unwrap(await backendApi.put<CaptureDevice>(`${base(accountId)}/devices/${deviceId}/link`, { user_id: userId }));
}

// ── Enrollment (IT rollout, `capture.manage`) ────────────────────────────────

export async function listCaptureEnrollmentTokens(accountId: string) {
  return unwrap(await backendApi.get<{ tokens: CaptureEnrollmentToken[] }>(`${base(accountId)}/enrollment-tokens`));
}

/** Create an enrollment token. The answer carries the secret once. */
export async function createCaptureEnrollmentToken(accountId: string, input: CaptureEnrollmentTokenInput) {
  return unwrap(await backendApi.post<CaptureEnrollmentTokenSecret>(`${base(accountId)}/enrollment-tokens`, input));
}

/** Revoke an enrollment token. Computers it enrolled keep recording; new ones are refused. */
export async function revokeCaptureEnrollmentToken(accountId: string, tokenId: string) {
  return unwrap(await backendApi.delete<CaptureEnrollmentToken>(`${base(accountId)}/enrollment-tokens/${tokenId}`));
}

/** Computers that presented an enrollment token, last seen first. */
export async function listCaptureEnrollments(accountId: string, opts: { status?: CaptureEnrollmentStatus } = {}) {
  return unwrap(
    await backendApi.get<{ enrollments: CaptureEnrollment[] }>(`${base(accountId)}/enrollments${captureQuery({ status: opts.status })}`),
  );
}

/** Approve a waiting computer, linked to a member or (no `userId`) to no one; it enrolls at its next call, within a minute. */
export async function approveCaptureEnrollment(accountId: string, enrollmentId: string, userId?: string | null) {
  return unwrap(
    await backendApi.post<CaptureEnrollment>(
      `${base(accountId)}/enrollments/${enrollmentId}/approve`,
      userId ? { user_id: userId } : {},
    ),
  );
}

/** Deny a computer; a device it enrolled is revoked at once. */
export async function denyCaptureEnrollment(accountId: string, enrollmentId: string) {
  return unwrap(await backendApi.post<CaptureEnrollment>(`${base(accountId)}/enrollments/${enrollmentId}/deny`, {}));
}

// ── Policy ────────────────────────────────────────────────────────────────────

export async function getCapturePolicy(accountId: string) {
  return unwrap(await backendApi.get<CapturePolicyRecord>(`${base(accountId)}/policy`));
}

/** Replace the account policy and publish it to devices (`capture.manage`). */
export async function setCapturePolicy(accountId: string, policy: CapturePolicy) {
  return unwrap(await backendApi.put<CapturePolicyRecord>(`${base(accountId)}/policy`, { policy }));
}

// ── Storage (where recordings are kept, `capture.manage`) ────────────────────

/** Where the account keeps its recordings: the managed store, or its own S3 bucket. The secret is never returned. */
export async function getCaptureStorage(accountId: string) {
  return unwrap(await backendApi.get<CaptureStorageView>(`${base(accountId)}/storage`));
}

/**
 * Set the account's storage destination (`capture.manage`). An `s3` config is
 * validated with a write probe before it is stored; an unreachable bucket
 * answers 400 `capture_storage_unreachable`.
 */
export async function setCaptureStorage(accountId: string, input: CaptureStorageInput) {
  return unwrap(await backendApi.put<CaptureStorageView>(`${base(accountId)}/storage`, input));
}

// ── Timeline ──────────────────────────────────────────────────────────────────

/** Activity runs and indexed items of one person for a day or a time span. */
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
export async function getCaptureFrame(
  accountId: string,
  frameId: string,
  opts: { userId?: string; deviceId?: string } = {},
) {
  return unwrap(
    await backendApi.get<CaptureFrameDetail>(
      `${base(accountId)}/frames/${frameId}${captureQuery({ user_id: opts.userId, device_id: opts.deviceId })}`,
    ),
  );
}

/**
 * Signed URLs of an indexed item's video or audio. `deviceId` reads a computer
 * linked to no one as itself (`capture.read_all`), like the timeline does.
 */
export async function getCaptureChunkMedia(
  accountId: string,
  chunkId: string,
  opts: { userId?: string; deviceId?: string } = {},
) {
  return unwrap(
    await backendApi.get<CaptureChunkMedia>(
      `${base(accountId)}/chunks/${chunkId}/media${captureQuery({ user_id: opts.userId, device_id: opts.deviceId })}`,
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
