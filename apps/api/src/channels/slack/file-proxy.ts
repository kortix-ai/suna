/**
 * Server-side Slack file proxy — the binary/multipart ops the Connector gateway
 * (JSON in/out) can't carry, done with the bot token SERVER-SIDE so the sandbox
 * never holds it. Backs the in-sandbox `slack download` + `slack send --file`
 * once the token is pulled from the box (KORTIX-206 Phase C2).
 */
import { dbChannelOwnership, gateChannelRead, type ChannelOwnership } from '../../connectors/channel-read-scope';
import { DOWNLOAD_TOO_LARGE, readCapped } from '../core/download';
import { loadSlackTokenForProject } from '../install-store';
import { getFileInfo } from '../slack-api';
import { logger } from '../../lib/logger';

const SLACK_API = 'https://slack.com/api';
// Only ever attach the bot token to Slack's FILE-serving hosts — `url` is
// caller-supplied, so this is the SSRF guard that stops the token leaking to an
// arbitrary origin. Narrowed from the apex `slack.com` (where `/api/*` lives,
// reachable with the bot token attached) to the file subdomains only. See S3-2.
const SLACK_HOST = /^(files|files-origin|files-priv|files-private|files-public)\.slack\.com$/i;
/**
 * A file URL names its file: `/files-pri/<team>-<file>/[download/]<name>`
 * (`url_private`, `url_private_download`) or `/files-tmb/<team>-<file>-<hash>/<name>`
 * (a thumbnail).
 */
const SLACK_FILE_PATH = /^\/files-(?:pri|tmb)\/T[A-Z0-9]+-(F[A-Z0-9]+)(?:-[a-z0-9]+)?\/(?:download\/)?[^/]+$/;

export type FileProxyStatus = 400 | 403 | 404 | 413 | 429 | 502;
export type FileProxyError = { ok: false; error: string; status: FileProxyStatus };

/** A failed download carries its upstream cause: the real status (null when
 * the fetch never got an answer) and a short body excerpt. */
interface DownloadFailure {
  ok: false;
  upstreamStatus: number | null;
  summary: string;
}

/** Up to 200 bytes of an upstream error body, whitespace-flattened: the only
 * evidence a failed download leaves, and often the only text Slack sends. */
async function errorExcerpt(res: Response): Promise<string> {
  const raw = await res.text().catch(() => '');
  return raw.replace(/\s+/g, ' ').trim().slice(0, 200);
}

/**
 * Fetch a Slack-hosted file, retrying exactly what slackApiCall retries: a 429
 * per its Retry-After (capped at 5 s) and, this being an idempotent GET, a 5xx
 * or unreachable host with the same attempt × 400 ms backoff. The files host
 * answers fast non-2xx under transient degradation (2026-10-05: 16 downloads
 * failed within 3 h, 8 back-to-back in one minute, clean 200s between bursts),
 * which a single unguarded fetch surfaced as a bare 502 with no log line.
 */
async function fetchSlackFile(url: string, token: string): Promise<{ ok: true; res: Response } | DownloadFailure> {
  let last: { upstreamStatus: number | null; summary: string } | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60_000) });
    } catch (err) {
      const timedOut = (err as Error)?.name === 'TimeoutError';
      last = { upstreamStatus: null, summary: timedOut ? 'upstream unreachable (timed out)' : 'upstream unreachable (network error)' };
      if (attempt < 2) {
        await Bun.sleep(400);
        continue;
      }
      break;
    }
    if (res.ok) return { ok: true, res };
    const excerpt = await errorExcerpt(res);
    last = { upstreamStatus: res.status, summary: `upstream ${res.status}${excerpt ? `: ${excerpt}` : ''}` };
    if (attempt === 2) break;
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after')) || attempt;
      if (retryAfter > 5) break; // too long to hold the request: answer 429 now
      await Bun.sleep(retryAfter * 1000);
      continue;
    }
    if (res.status >= 500) {
      await Bun.sleep(attempt * 400);
      continue;
    }
    break;
  }
  return { ok: false, upstreamStatus: last?.upstreamStatus ?? null, summary: last?.summary ?? 'upstream unreachable' };
}

/**
 * Fetch a Slack-hosted file with the project's bot token. SSRF-guarded, and
 * confined like a `file_info` read: one workspace token serves every project
 * connected to that workspace, so the file must be shared in a conversation
 * this project may read (connectors/channel-read-scope.ts).
 */
export async function downloadSlackFile(
  projectId: string,
  url: string,
  ownership: ChannelOwnership = dbChannelOwnership,
): Promise<{ ok: true; body: Uint8Array; contentType: string } | FileProxyError> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: 'invalid url', status: 400 };
  }
  if (parsed.protocol !== 'https:' || !SLACK_HOST.test(parsed.hostname)) {
    return { ok: false, error: 'url must be an https://*.slack.com file URL', status: 400 };
  }
  const fileId = SLACK_FILE_PATH.exec(parsed.pathname)?.[1];
  if (!fileId) {
    return { ok: false, error: 'url must be a Slack file URL (url_private or url_private_download)', status: 400 };
  }
  const token = await loadSlackTokenForProject(projectId);
  if (!token) return { ok: false, error: 'Slack not connected for this project', status: 404 };

  const info = await getFileInfo(token, fileId);
  if (!info.ok) return { ok: false, error: `Slack file ${fileId}: ${info.error ?? 'not found'}`, status: 404 };
  const gate = await gateChannelRead(
    { projectId, platform: 'slack', actionPath: 'file_info', args: { file: fileId }, risk: 'read' },
    ownership,
  );
  const answer = gate.refusal ? { refusal: gate.refusal } : await gate.answer(info);
  if ('refusal' in answer) return { ok: false, error: answer.refusal.message, status: 403 };

  const dl = await fetchSlackFile(parsed.href, token);
  if (!dl.ok) {
    // One warn per download outcome, never per attempt (see the learnings
    // ledger): without it the upstream cause is guesswork from response
    // durations alone.
    logger.warn('[slack-file] download failed', {
      project_id: projectId,
      upstream_status: dl.upstreamStatus,
      summary: dl.summary,
    });
    // Map the upstream answer honestly instead of flattening every failure
    // into 502: 429 is rate limiting (the caller may retry), 403/404 mean this
    // token cannot serve this file (both declared responses); anything else,
    // and every unreachable/timeout answer, stays 502.
    const status: FileProxyStatus =
      dl.upstreamStatus === 429 ? 429 : dl.upstreamStatus === 403 ? 403 : dl.upstreamStatus === 404 ? 404 : 502;
    return { ok: false, error: `download failed: ${dl.summary}`, status };
  }
  const body = await readCapped(dl.res);
  if (!body) return { ok: false, error: DOWNLOAD_TOO_LARGE, status: 413 };
  return { ok: true, body, contentType: dl.res.headers.get('content-type') ?? 'application/octet-stream' };
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
  const reserve = (await fetch(`${SLACK_API}/files.getUploadURLExternal`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ filename: args.filename, length: String(bytes.length) }),
    signal: AbortSignal.timeout(15_000),
  }).then((r) => r.json())) as { ok?: boolean; error?: string; upload_url?: string; file_id?: string };
  if (!reserve.ok || !reserve.upload_url || !reserve.file_id) {
    return { ok: false, error: reserve.error ?? 'getUploadURLExternal failed', status: 502 };
  }

  // 2. PUT the bytes to the reserved URL (no token — it's pre-signed).
  const put = await fetch(reserve.upload_url, { method: 'POST', body: bytes, signal: AbortSignal.timeout(60_000) });
  if (!put.ok) return { ok: false, error: `upload failed: HTTP ${put.status}`, status: 502 };

  // 3. Finalize → posts the file into the channel/thread.
  const complete = (await fetch(`${SLACK_API}/files.completeUploadExternal`, {
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
