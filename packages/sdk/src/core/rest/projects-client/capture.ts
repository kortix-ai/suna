// Kortix Capture — a member's screen, actions and audio as a searchable timeline.
//
// The desktop app writes the Kortix Capture format (schema 2) to the project's
// capture store; Kortix indexes it. Everything here is project-scoped and needs
// the project's `capture` feature flag. A member reads only their own devices
// and timeline; a project manager may name another member (`userId`) or the
// whole project (`scope: 'project'`, `getCapturePeople`), and every such read is
// audited. An agent session reads only the timeline of the person it acts for.
//
// The device sign-in itself (RFC 8628) is the desktop app's business; the
// approval half — a signed-in person picking the project — is here
// (`getCaptureDeviceGrant`, `approveCaptureDeviceGrant`, `denyCaptureDeviceGrant`).

import { backendApi } from '../../http/api-client';
import { unwrap } from './shared';

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
  policy_override: CapturePolicy | null;
  last_credentials_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

/** Whose data and when. `day` (UTC `YYYY-MM-DD`) or `from`/`to` (ISO, at most 31 days); default today. */
export interface CaptureWindowQuery {
  day?: string;
  from?: string;
  to?: string;
  /** Another member (managers only, audited). Default: the caller. */
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

export interface CaptureRange {
  range_id: string;
  user_id: string;
  device_id: string | null;
  /** `detected` = an activity session split by idle gaps; `saved` = a span a person saved. */
  source: 'detected' | 'saved';
  title: string | null;
  start_at: string;
  end_at: string;
  status: 'open' | 'closed' | 'processing' | 'processed' | 'failed';
  created_by: string | null;
  created_at: string;
}

export interface CaptureTimeline {
  user_id: string;
  from: string;
  to: string;
  runs: CaptureActivityRun[];
  chunks: CaptureChunk[];
  ranges: CaptureRange[];
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
  /** Another member (managers only, audited). Default: the caller. */
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
}

export interface CaptureSearchHit {
  kind: CaptureSearchKind;
  /** frame_id, action_id or line_id. */
  id: string;
  ts: string;
  device_id: string;
  chunk_id: string;
  app: string | null;
  title: string | null;
  url: string | null;
  snippet: string;
}

export interface CaptureSearchResult {
  user_id: string;
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
}

export interface CaptureChunkMedia {
  chunk_id: string;
  kind: CaptureChunk['kind'];
  video: CaptureMediaUrl | null;
  audio: CaptureMediaUrl | null;
}

export interface SaveCaptureRangeInput {
  start_at: string;
  /** At most 24 hours after `start_at`. */
  end_at: string;
  title?: string;
  /** Limit the range to one of your devices. Default: all of them. */
  device_id?: string;
}

export interface CaptureRangeOutput {
  kind: 'segmentation' | 'transcript' | 'annotation';
  status: 'running' | 'done' | 'failed';
  model: string | null;
  output: Record<string, unknown> | null;
  /** `{ requests, prompt_tokens, completion_tokens, cost_usd }`. */
  usage: Record<string, unknown> | null;
  error: string | null;
  updated_at: string;
}

export interface CaptureRangeDetail extends CaptureRange {
  outputs: CaptureRangeOutput[];
}

export interface CapturePersonSummary {
  user_id: string;
  active_seconds: number;
  apps: Array<{ app: string | null; seconds: number }>;
  ranges: number;
  devices: number;
}

export interface CapturePeopleSummary {
  from: string;
  to: string;
  people: CapturePersonSummary[];
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
  project_id: string | null;
  device_id: string | null;
}

const base = (projectId: string) => `/projects/${projectId}/capture`;

function captureQuery(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `?${query}` : '';
}

const windowParams = (query: CaptureWindowQuery = {}) => ({
  day: query.day,
  from: query.from,
  to: query.to,
  user_id: query.userId,
  device_id: query.deviceId,
});

// ── Devices ───────────────────────────────────────────────────────────────────

/** Your devices with live status; a member's (`userId`) or the project's (`scope: 'project'`) for managers. */
export async function listCaptureDevices(projectId: string, opts: { userId?: string; scope?: 'mine' | 'project' } = {}) {
  return unwrap(
    await backendApi.get<{ devices: CaptureDevice[] }>(
      `${base(projectId)}/devices${captureQuery({ user_id: opts.userId, scope: opts.scope })}`,
    ),
  );
}

/** Revoke a device: its token stops working at once. Your own device, or any device for managers. */
export async function revokeCaptureDevice(projectId: string, deviceId: string) {
  return unwrap(await backendApi.delete<CaptureDevice>(`${base(projectId)}/devices/${deviceId}`));
}

/**
 * Read a device's status, description and index now, and queue every new item
 * for indexing (a "Sync now"). Without it the readers pick items up within a
 * minute. `forgotten` counts the items the device deleted (the person forgot a
 * time range, or the device's retention removed it), which Kortix retracted
 * with the outputs of every range that overlapped them. Your own device, or
 * any device for managers.
 */
export async function syncCaptureDevice(projectId: string, deviceId: string) {
  return unwrap(
    await backendApi.post<{ device_id: string; enqueued: number; forgotten: number }>(`${base(projectId)}/devices/${deviceId}/sync`, {}),
  );
}

/** Set (or clear with null) one device's policy override. Managers only. */
export async function setCaptureDevicePolicy(projectId: string, deviceId: string, policy: CapturePolicy | null) {
  return unwrap(await backendApi.put<CaptureDevice>(`${base(projectId)}/devices/${deviceId}/policy`, { policy }));
}

// ── Policy ────────────────────────────────────────────────────────────────────

export async function getCapturePolicy(projectId: string) {
  return unwrap(await backendApi.get<CapturePolicyRecord>(`${base(projectId)}/policy`));
}

/** Replace the project policy and publish it to devices. Managers only. */
export async function setCapturePolicy(projectId: string, policy: CapturePolicy) {
  return unwrap(await backendApi.put<CapturePolicyRecord>(`${base(projectId)}/policy`, { policy }));
}

// ── Timeline ──────────────────────────────────────────────────────────────────

/** Activity runs, indexed items and ranges of one person for a day or a time span. */
export async function getCaptureTimeline(projectId: string, query: CaptureWindowQuery = {}) {
  return unwrap(
    await backendApi.get<CaptureTimeline>(`${base(projectId)}/timeline${captureQuery(windowParams(query))}`),
  );
}

/** Frames, actions and audio lines of one person in a time span. */
export async function getCaptureTimelineItems(projectId: string, query: CaptureWindowQuery = {}) {
  return unwrap(
    await backendApi.get<CaptureTimelineItems>(`${base(projectId)}/timeline/items${captureQuery(windowParams(query))}`),
  );
}

/** The days with recorded items, newest first: the day picker of a timeline. */
export async function getCaptureDays(projectId: string, query: CaptureDaysQuery = {}) {
  return unwrap(
    await backendApi.get<CaptureDays>(
      `${base(projectId)}/days${captureQuery({ tz: query.tz, user_id: query.userId, device_id: query.deviceId })}`,
    ),
  );
}

/** Full-text search across screen (app, window, URL, on-screen text), actions and audio. */
export async function searchCapture(projectId: string, query: CaptureSearchQuery) {
  return unwrap(
    await backendApi.get<CaptureSearchResult>(
      `${base(projectId)}/search${captureQuery({
        q: query.q,
        kinds: query.kinds?.join(','),
        app: query.app,
        limit: query.limit,
        from: query.from,
        to: query.to,
        user_id: query.userId,
        device_id: query.deviceId,
      })}`,
    ),
  );
}

// ── Media ─────────────────────────────────────────────────────────────────────

/** One frame with its full on-screen text and a signed URL of its video chunk. */
export async function getCaptureFrame(projectId: string, frameId: string, opts: { userId?: string } = {}) {
  return unwrap(
    await backendApi.get<CaptureFrameDetail>(
      `${base(projectId)}/frames/${frameId}${captureQuery({ user_id: opts.userId })}`,
    ),
  );
}

/** Signed URLs of an indexed item's video or audio. */
export async function getCaptureChunkMedia(projectId: string, chunkId: string, opts: { userId?: string } = {}) {
  return unwrap(
    await backendApi.get<CaptureChunkMedia>(
      `${base(projectId)}/chunks/${chunkId}/media${captureQuery({ user_id: opts.userId })}`,
    ),
  );
}

/** A signed URL of one content-addressed asset (an action screenshot). */
export async function getCaptureAssetUrl(projectId: string, deviceId: string, name: string) {
  return unwrap(
    await backendApi.get<CaptureSignedUrl>(`${base(projectId)}/devices/${deviceId}/assets/${encodeURIComponent(name)}`),
  );
}

// ── Ranges ────────────────────────────────────────────────────────────────────

export async function listCaptureRanges(projectId: string, query: CaptureWindowQuery = {}) {
  return unwrap(
    await backendApi.get<{ ranges: CaptureRange[] }>(`${base(projectId)}/ranges${captureQuery(windowParams(query))}`),
  );
}

/** Save a span of your own timeline as a range; its pipelines start at once. */
export async function saveCaptureRange(projectId: string, input: SaveCaptureRangeInput) {
  return unwrap(await backendApi.post<CaptureRange>(`${base(projectId)}/ranges`, input));
}

/** One range with its outputs: segmentation (work vs idle), transcript, annotation. */
export async function getCaptureRange(projectId: string, rangeId: string) {
  return unwrap(await backendApi.get<CaptureRangeDetail>(`${base(projectId)}/ranges/${rangeId}`));
}

/** Run a range's pipelines again. */
export async function processCaptureRange(projectId: string, rangeId: string) {
  return unwrap(
    await backendApi.post<{ range_id: string; queued: boolean }>(`${base(projectId)}/ranges/${rangeId}/process`, {}),
  );
}

// ── People (managers) ─────────────────────────────────────────────────────────

/** Per member: active time, time per app, ranges and devices. Managers only; audited. */
export async function getCapturePeople(projectId: string, query: Omit<CaptureWindowQuery, 'userId' | 'deviceId'> = {}) {
  return unwrap(
    await backendApi.get<CapturePeopleSummary>(
      `${base(projectId)}/people${captureQuery({ day: query.day, from: query.from, to: query.to })}`,
    ),
  );
}

// ── Device sign-in approval ───────────────────────────────────────────────────

/** The device asking to sign in with this user code (the approval page). */
export async function getCaptureDeviceGrant(userCode: string) {
  return unwrap(await backendApi.get<CaptureDeviceGrant>(`/capture/device/grants/${encodeURIComponent(userCode)}`));
}

/** Pair the device to you in one of your projects with capture on. The device keeps its own identity. */
export async function approveCaptureDeviceGrant(userCode: string, projectId: string) {
  return unwrap(
    await backendApi.post<CaptureDeviceGrant>(`/capture/device/grants/${encodeURIComponent(userCode)}/approve`, {
      project_id: projectId,
    }),
  );
}

export async function denyCaptureDeviceGrant(userCode: string) {
  return unwrap(
    await backendApi.post<CaptureDeviceGrant>(`/capture/device/grants/${encodeURIComponent(userCode)}/deny`, {}),
  );
}
