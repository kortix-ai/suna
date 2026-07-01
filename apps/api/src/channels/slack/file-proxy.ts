import type { Effect } from 'effect';
/**
 * Server-side Slack file proxy — the binary/multipart ops the Executor gateway
 * (JSON in/out) can't carry, done with the bot token SERVER-SIDE so the sandbox
 * never holds it. Backs the in-sandbox `slack download` + `slack send --file`
 * once the token is pulled from the box (KORTIX-206 Phase C2).
 */
import { loadSlackTokenForProject } from '../install-store';
import { sharedFetch } from '../../shared/effect';

const SLACK_API = 'https://slack.com/api';
// Only ever attach the bot token to Slack's own hosts — `url` is caller-supplied,
// so this is the SSRF guard that stops the token leaking to an arbitrary origin.
const SLACK_HOST = /(^|\.)slack\.com$/i;

export type FileProxyError = { ok: false; error: string; status: number };

/** Fetch a Slack-hosted file with the project's bot token. SSRF-guarded. */
export async function downloadSlackFile(
  projectId: string,
  url: string,
): Promise<{ ok: true; body: ArrayBuffer; contentType: string } | FileProxyError> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: 'invalid url', status: 400 };
  }
  if (parsed.protocol !== 'https:' || !SLACK_HOST.test(parsed.hostname)) {
    return { ok: false, error: 'url must be an https://*.slack.com file URL', status: 400 };
  }
  const token = await loadSlackTokenForProject(projectId);
  if (!token) return { ok: false, error: 'Slack not connected for this project', status: 404 };

  const res = await sharedFetch(parsed.href, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) return { ok: false, error: `download failed: HTTP ${res.status}`, status: 502 };
  return {
    ok: true,
    body: await res.arrayBuffer(),
    contentType: res.headers.get('content-type') ?? 'application/octet-stream',
  };
}

/** Upload a file to Slack (the 3-step external-upload flow), token server-side. */
export async function uploadSlackFile(
  projectId: string,
  args: { channel: string; filename: string; contentBase64: string; comment?: string; threadTs?: string },
): Promise<{ ok: true; files: unknown } | FileProxyError> {
  if (!args.channel || !args.filename || !args.contentBase64) {
    return { ok: false, error: 'channel, filename and content_base64 are required', status: 400 };
  }
  const token = await loadSlackTokenForProject(projectId);
  if (!token) return { ok: false, error: 'Slack not connected for this project', status: 404 };

  const bytes = Buffer.from(args.contentBase64, 'base64');

  // 1. Reserve an upload URL (form-encoded — Slack's API for this method).
  const reserve = (await sharedFetch(`${SLACK_API}/files.getUploadURLExternal`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ filename: args.filename, length: String(bytes.length) }),
    signal: AbortSignal.timeout(15_000),
  }).then((r) => r.json())) as { ok?: boolean; error?: string; upload_url?: string; file_id?: string };
  if (!reserve.ok || !reserve.upload_url || !reserve.file_id) {
    return { ok: false, error: reserve.error ?? 'getUploadURLExternal failed', status: 502 };
  }

  // 2. PUT the bytes to the reserved URL (no token — it's pre-signed).
  const put = await sharedFetch(reserve.upload_url, { method: 'POST', body: bytes, signal: AbortSignal.timeout(60_000) });
  if (!put.ok) return { ok: false, error: `upload failed: HTTP ${put.status}`, status: 502 };

  // 3. Finalize → posts the file into the channel/thread.
  const complete = (await sharedFetch(`${SLACK_API}/files.completeUploadExternal`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      files: [{ id: reserve.file_id, title: args.filename }],
      channel_id: args.channel,
      ...(args.comment ? { initial_comment: args.comment } : {}),
      ...(args.threadTs ? { thread_ts: args.threadTs } : {}),
    }),
    signal: AbortSignal.timeout(15_000),
  }).then((r) => r.json())) as { ok?: boolean; error?: string; files?: unknown };
  if (!complete.ok) return { ok: false, error: complete.error ?? 'completeUploadExternal failed', status: 502 };
  return { ok: true, files: complete.files };
}
