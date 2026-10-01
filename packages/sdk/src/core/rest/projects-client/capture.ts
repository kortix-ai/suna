// Kortix Capture — the user API: account switch, the caller's recording
// devices, and search over what they captured. Recordings belong to the user
// who captured them; an owner or admin reads another member's only when the
// owner enabled `admins_can_view` (each such read is audited).

import { backendApi } from '../../http/api-client';
import { unwrap } from './shared';

export interface CaptureSettings {
  enabled: boolean;
  /** Owners and admins may read members' captures (owner-only switch). */
  admins_can_view: boolean;
  retention_days: number;
  updated_at: string | null;
}

export interface CaptureDevice {
  id: string;
  /** The account that owns this device's recordings. */
  account_id: string;
  tunnel_id: string;
  name: string;
  enabled: boolean;
  paused_until: string | null;
  last_upload_at: string | null;
  last_seen_at: string | null;
  account_enabled: boolean;
  admins_can_view: boolean;
}

export interface CaptureSearchOptions {
  q?: string;
  from?: string;
  to?: string;
  app?: string;
  domain?: string;
  /** Another member's captures (owner/admin, `admins_can_view` on). Default: the caller. */
  user_id?: string;
  limit?: number;
  cursor?: string;
}

export interface CaptureSearchItem {
  frame_id: number;
  chunk_id: string;
  frame_index: number;
  ts: string;
  app_name: string | null;
  window_title: string | null;
  url: string | null;
  domain: string | null;
  /** The match, wrapped in `<b>…</b>`. */
  snippet: string;
}

export interface CaptureSearchPage {
  items: CaptureSearchItem[];
  next_cursor: string | null;
}

export interface CaptureTimeline {
  chunks: Array<{
    chunk_id: string;
    started_at: string;
    ended_at: string;
    frame_count: number;
    device_name: string | null;
  }>;
  apps: Array<{ app_name: string; seconds: number }>;
}

export interface CaptureFrame {
  frame_id: number;
  chunk_id: string;
  user_id: string;
  frame_index: number;
  ts: string;
  app_bundle: string | null;
  app_name: string | null;
  window_title: string | null;
  url: string | null;
  domain: string | null;
  text: string | null;
}

function query(params: Record<string, string | number | undefined>): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') qs.set(key, String(value));
  }
  const text = qs.toString();
  return text ? `?${text}` : '';
}

const base = (accountId: string) => `/accounts/${accountId}/capture`;

/** Any account member may read the settings. */
export async function getCaptureSettings(accountId: string) {
  return unwrap(await backendApi.get<CaptureSettings>(`${base(accountId)}/settings`));
}

/** Owner or admin; `admins_can_view` is owner-only. Send only the fields to change. */
export async function updateCaptureSettings(
  accountId: string,
  input: Partial<Pick<CaptureSettings, 'enabled' | 'admins_can_view' | 'retention_days'>>,
) {
  return unwrap(await backendApi.put<CaptureSettings>(`${base(accountId)}/settings`, input));
}

/** The caller's own machines, across accounts. */
export async function listCaptureDevices() {
  return unwrap(await backendApi.get<{ devices: CaptureDevice[] }>('/capture/devices'));
}

/** Device owner only. `account_id` moves the device to an account the owner belongs to. */
export async function updateCaptureDevice(
  deviceId: string,
  input: { enabled?: boolean; paused_until?: string | null; account_id?: string },
) {
  return unwrap(
    await backendApi.put<{ id: string; account_id: string; enabled: boolean; paused_until: string | null }>(
      `/capture/devices/${deviceId}`,
      input,
    ),
  );
}

export async function searchCapture(accountId: string, options: CaptureSearchOptions = {}) {
  return unwrap(
    await backendApi.get<CaptureSearchPage>(`${base(accountId)}/search${query({ ...options })}`),
  );
}

export async function getCaptureTimeline(
  accountId: string,
  options: { from?: string; to?: string; user_id?: string } = {},
) {
  return unwrap(await backendApi.get<CaptureTimeline>(`${base(accountId)}/timeline${query(options)}`));
}

/** A presigned GET for one chunk's mp4 (10 minutes). */
export async function getCaptureVideoUrl(accountId: string, chunkId: string) {
  return unwrap(
    await backendApi.get<{ url: string; expires_at: string }>(`${base(accountId)}/chunks/${chunkId}/video`),
  );
}

export async function getCaptureFrame(accountId: string, frameId: number) {
  return unwrap(await backendApi.get<CaptureFrame>(`${base(accountId)}/frames/${frameId}`));
}

/** Deletes the caller's own chunks (video and frames) started in [from, to). No range = all. */
export async function deleteCaptureData(accountId: string, range: { from?: string; to?: string } = {}) {
  return unwrap(
    await backendApi.delete<{ deleted_chunks: number }>(`${base(accountId)}/data${query(range)}`),
  );
}
