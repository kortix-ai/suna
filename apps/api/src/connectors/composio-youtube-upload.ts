/**
 * `youtube.upload_video`: upload a video file from the session to the
 * signed-in YouTube channel, at any size.
 *
 * Composio's own upload tools cannot read a file in the sandbox.
 * `YOUTUBE_UPLOAD_VIDEO` reads a path on Composio's servers, and
 * `YOUTUBE_MULTIPART_UPLOAD_VIDEO` reads a public URL of at most 100 MB.
 *
 * This action replaces `YOUTUBE_UPLOAD_VIDEO`. It starts a YouTube resumable
 * upload on the connection's account: Composio's proxy adds the sign-in, and
 * the answer's `Location` header is the upload session URL. The action
 * returns that URL and a ready-to-run `curl` command. The sandbox then sends
 * the file to the URL itself:
 *
 *   - the bytes go from the sandbox straight to Google (up to YouTube's 256 GB);
 *   - the Google token never leaves Composio.
 *
 * The upload URL is a credential for this one video: whoever holds it can
 * write this video's bytes, nothing else. It expires after about a week.
 */
import { CALLER_ONLY_KEY } from './args-preview';
import type { ExecResult } from './call';
import type { ComposioToolLike } from './types';

export const YOUTUBE_UPLOAD_TOOL = 'YOUTUBE_UPLOAD_VIDEO';

/** YouTube's resumable upload endpoint (YouTube Data API v3, `videos.insert`). */
export const YOUTUBE_UPLOAD_ENDPOINT = 'https://www.googleapis.com/upload/youtube/v3/videos';

/** YouTube's own limits on `snippet.title` (characters) and `snippet.description` (bytes). */
const MAX_TITLE = 100;
const MAX_DESCRIPTION_BYTES = 5000;
/** YouTube's largest accepted video file. */
const MAX_FILE_BYTES = 256 * 1024 ** 3;
const PRIVACY = ['private', 'unlisted', 'public'] as const;

export interface ComposioProxyRequest {
  toolkit: string;
  endpoint: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  body?: unknown;
  parameters?: Array<{ in: 'query' | 'header'; name: string; value: string | number }>;
}

export interface ComposioProxyResponse {
  status: number;
  data?: unknown;
  headers?: Record<string, string>;
}

export interface YoutubeUploadSession {
  sessionId: string;
  proxyExecute?(request: ComposioProxyRequest): Promise<ComposioProxyResponse>;
}

export const youtubeUploadTool: ComposioToolLike = {
  type: 'function',
  function: {
    name: YOUTUBE_UPLOAD_TOOL,
    description: [
      'Upload a video file from this session to the signed-in YouTube channel. Any size; no public URL needed.',
      'Step 1: call this with the metadata (and file_path, file_size). It answers caller_only.upload_command.',
      'Step 2: run that command in the shell. curl sends the file straight to YouTube and prints the video JSON:',
      'its id is the video (https://youtu.be/<id>).',
      'The video is private unless privacy_status says otherwise. The upload URL serves this one video only.',
    ].join(' '),
    parameters: {
      type: 'object',
      required: ['title'],
      properties: {
        title: { type: 'string', maxLength: MAX_TITLE, description: 'Video title. At most 100 characters, no < or >.' },
        description: { type: 'string', description: 'Video description. At most 5000 bytes, no < or >.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Keyword tags.' },
        category_id: {
          type: 'string',
          description: 'YouTube category id, e.g. "22" People & Blogs, "27" Education, "28" Science & Technology. Default: the channel default.',
        },
        privacy_status: {
          type: 'string',
          enum: [...PRIVACY],
          default: 'private',
          description: 'Who can watch it. Default private.',
        },
        publish_at: {
          type: 'string',
          format: 'date-time',
          description: 'Schedule: ISO 8601 time when YouTube makes the video public. Needs privacy_status private.',
        },
        made_for_kids: {
          type: 'boolean',
          description: 'Whether the video is made for kids (COPPA). Omit to use the channel default.',
        },
        contains_synthetic_media: {
          type: 'boolean',
          description: 'Discloses realistic altered or synthetic (AI-generated) content, as YouTube requires.',
        },
        notify_subscribers: {
          type: 'boolean',
          default: true,
          description: 'Notify the channel subscribers about the new video. Default true.',
        },
        default_language: { type: 'string', description: 'Language of the title and description, e.g. "en".' },
        file_path: {
          type: 'string',
          description: 'Path of the video file in this session, e.g. /workspace/output/video.mp4. Only written into upload_command.',
        },
        file_size: {
          type: 'integer',
          minimum: 1,
          description: 'File size in bytes (`stat -c %s <file>`). Lets YouTube reject a too-large file before the upload starts.',
        },
        mime_type: {
          type: 'string',
          default: 'video/*',
          description: 'The file type, e.g. video/mp4 or video/quicktime. Default video/*.',
        },
      },
    },
  },
};

interface KortixComposioTool {
  tool: ComposioToolLike;
  run(session: YoutubeUploadSession, args: Record<string, unknown>, toolkit: string): Promise<ExecResult>;
}

/**
 * The tools Kortix runs itself on a Composio toolkit, by toolkit slug. Each
 * replaces the Composio tool of the same name in the connector's actions.
 */
const KORTIX_COMPOSIO_TOOLS: Readonly<Record<string, readonly KortixComposioTool[]>> = {
  youtube: [{ tool: youtubeUploadTool, run: (session, args, toolkit) => startYoutubeUpload(session, args, toolkit) }],
};

/** `tools` with Composio's tools of the same name replaced by Kortix's own. */
export function withKortixComposioTools<T extends { function?: { name?: string } }>(
  tools: T[],
  toolkit: string,
): Array<T | ComposioToolLike> {
  const own = (KORTIX_COMPOSIO_TOOLS[toolkit.toLowerCase()] ?? []).map((entry) => entry.tool);
  if (own.length === 0) return tools;
  const names = new Set(own.map((tool) => tool.function.name));
  return [...tools.filter((tool) => !names.has(tool?.function?.name ?? '')), ...own];
}

/** The Kortix tool that runs `toolSlug` of `toolkit` instead of Composio, if any. */
export function kortixComposioTool(toolkit: string, toolSlug: string): KortixComposioTool | null {
  return (KORTIX_COMPOSIO_TOOLS[toolkit.toLowerCase()] ?? []).find((entry) => entry.tool.function.name === toolSlug) ?? null;
}

const callerError = (message: string): ExecResult => ({ ok: false, status: 400, data: message });

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A POSIX shell word: `'it'"'"'s'` for `it's`. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

interface UploadRequest {
  snippet: Record<string, unknown>;
  status: Record<string, unknown>;
  notifySubscribers: boolean;
  mimeType: string;
  fileSize: number | null;
  filePath: string | null;
}

/** Validate the arguments into a `videos.insert` body. A string is a refusal the caller can fix. */
export function youtubeUploadRequest(args: Record<string, unknown>, now = Date.now()): UploadRequest | string {
  const text = (key: string): string | null | undefined => {
    const value = args[key];
    if (value === undefined || value === null) return undefined;
    return typeof value === 'string' ? value : null;
  };
  const bool = (key: string): boolean | null | undefined => {
    const value = args[key];
    if (value === undefined || value === null) return undefined;
    return typeof value === 'boolean' ? value : null;
  };

  const title = text('title')?.trim();
  if (!title) return 'title is required';
  if (title.length > MAX_TITLE) return `title is ${title.length} characters; YouTube allows ${MAX_TITLE}`;
  if (/[<>]/.test(title)) return 'title must not contain < or >';

  const description = text('description');
  if (description === null) return 'description must be a string';
  if (description !== undefined) {
    const bytes = Buffer.byteLength(description, 'utf8');
    if (bytes > MAX_DESCRIPTION_BYTES) return `description is ${bytes} bytes; YouTube allows ${MAX_DESCRIPTION_BYTES}`;
    if (/[<>]/.test(description)) return 'description must not contain < or >';
  }

  const tags = args.tags;
  if (tags !== undefined && tags !== null && (!Array.isArray(tags) || tags.some((tag) => typeof tag !== 'string'))) {
    return 'tags must be an array of strings';
  }

  const categoryId = args.category_id;
  if (categoryId !== undefined && categoryId !== null && !/^\d+$/.test(String(categoryId))) {
    return 'category_id must be a numeric YouTube category id such as "22"';
  }

  const privacy = text('privacy_status') ?? 'private';
  if (privacy === null || !(PRIVACY as readonly string[]).includes(privacy)) {
    return `privacy_status must be one of ${PRIVACY.join(', ')}`;
  }

  const publishAt = text('publish_at');
  if (publishAt === null) return 'publish_at must be an ISO 8601 date-time string';
  if (publishAt !== undefined) {
    const at = Date.parse(publishAt);
    if (Number.isNaN(at)) return 'publish_at must be an ISO 8601 date-time, e.g. 2026-12-01T15:00:00Z';
    if (at <= now) return 'publish_at must be in the future';
    if (privacy !== 'private') return 'publish_at needs privacy_status private: YouTube makes the video public at that time';
  }

  const flags: Record<string, boolean | undefined> = {};
  for (const key of ['made_for_kids', 'contains_synthetic_media', 'notify_subscribers'] as const) {
    const value = bool(key);
    if (value === null) return `${key} must be true or false`;
    flags[key] = value;
  }

  const language = text('default_language');
  if (language === null) return 'default_language must be a string';

  const rawMime = text('mime_type');
  if (rawMime === null) return 'mime_type must be a string such as video/mp4';
  const mimeType = rawMime?.trim() || 'video/*';
  if (!/^(video\/[\w.+*-]+|application\/octet-stream)$/i.test(mimeType)) {
    return 'mime_type must be a video type such as video/mp4';
  }

  const rawSize = args.file_size;
  let fileSize: number | null = null;
  if (rawSize !== undefined && rawSize !== null) {
    const size = Number(rawSize);
    if (!Number.isSafeInteger(size) || size < 1) return 'file_size must be a positive whole number of bytes';
    if (size > MAX_FILE_BYTES) return 'file_size is over 256 GB, the largest file YouTube accepts';
    fileSize = size;
  }

  const filePath = text('file_path');
  if (filePath === null) return 'file_path must be a string';

  const snippet: Record<string, unknown> = { title };
  if (description !== undefined) snippet.description = description;
  if (Array.isArray(tags) && tags.length > 0) snippet.tags = tags;
  if (categoryId !== undefined && categoryId !== null) snippet.categoryId = String(categoryId);
  if (language?.trim()) snippet.defaultLanguage = language.trim();

  const status: Record<string, unknown> = { privacyStatus: privacy };
  if (publishAt !== undefined) status.publishAt = new Date(publishAt).toISOString();
  if (flags.made_for_kids !== undefined) status.selfDeclaredMadeForKids = flags.made_for_kids;
  if (flags.contains_synthetic_media !== undefined) status.containsSyntheticMedia = flags.contains_synthetic_media;

  return {
    snippet,
    status,
    notifySubscribers: flags.notify_subscribers ?? true,
    mimeType,
    fileSize,
    filePath: filePath?.trim() || null,
  };
}

function header(headers: Record<string, string> | undefined, name: string): string | null {
  if (!headers) return null;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted && typeof value === 'string' && value) return value;
  }
  return null;
}

/**
 * A used-up daily quota of the Google app (Cloud project) the account signed
 * in with, from the `google.rpc.ErrorInfo` detail of a 429. Live on dev
 * (2026-11-04), with Composio's managed app: `quota_limit:
 * defaultVideoInsertPerDayPerProject`, `quota_limit_value: "966"`,
 * `quota_unit: "1/d/{project}"`, `window_start_time: "1793779200"` (08:00 UTC,
 * midnight Pacific).
 */
interface DailyQuota {
  /** Uploads the app may start per day, when Google says. */
  limit: number | null;
  resetsAt: Date;
}

const DAY_SECONDS = 24 * 60 * 60;

/** YouTube's error reason and message, from a Google API error body. */
function googleError(data: unknown): { reason: string | null; message: string | null; quota: DailyQuota | null } {
  const error = isObject(data) && isObject(data.error) ? data.error : null;
  const first = error && Array.isArray(error.errors) && isObject(error.errors[0]) ? error.errors[0] : null;
  return {
    reason: typeof first?.reason === 'string' ? first.reason : null,
    message: typeof error?.message === 'string' ? error.message : null,
    quota: dailyQuota(error),
  };
}

function dailyQuota(error: Record<string, unknown> | null): DailyQuota | null {
  const details = error && Array.isArray(error.details) ? error.details : [];
  for (const detail of details) {
    if (!isObject(detail) || detail['@type'] !== 'type.googleapis.com/google.rpc.ErrorInfo') continue;
    const metadata = isObject(detail.metadata) ? detail.metadata : {};
    const unit = typeof metadata.quota_unit === 'string' ? metadata.quota_unit : '';
    const windowStart = Number(metadata.window_start_time);
    if (!unit.includes('/d/') || !Number.isSafeInteger(windowStart) || windowStart <= 0) continue;
    const limit = Number(metadata.quota_limit_value);
    return {
      limit: Number.isSafeInteger(limit) && limit > 0 ? limit : null,
      resetsAt: new Date((windowStart + DAY_SECONDS) * 1000),
    };
  }
  return null;
}

/** Seconds until the quota resets, or undefined when the reset is not in the future. */
function secondsUntil(quota: DailyQuota | null, now: Date): number | undefined {
  if (!quota) return undefined;
  const seconds = Math.ceil((quota.resetsAt.getTime() - now.getTime()) / 1000);
  return seconds > 0 && seconds <= DAY_SECONDS ? seconds : undefined;
}

/** What the agent can do about YouTube's refusal. */
function refusalHint(reason: string | null, quota: DailyQuota | null, now: Date): string {
  switch (reason) {
    case 'youtubeSignupRequired':
      return ' This Google account has no YouTube channel: create one at https://www.youtube.com/create_channel, then retry.';
    case 'uploadLimitExceeded':
      return ' This channel reached YouTube\'s own daily upload limit, which counts every upload to the channel: retry in 24 hours. Another Google app does not lift it.';
    case 'quotaExceeded':
    case 'rateLimitExceeded': {
      const wait = secondsUntil(quota, now);
      if (!quota || wait === undefined) {
        return ' YouTube limits uploads per day: retry later (the daily quota resets at midnight Pacific time).';
      }
      const count = quota.limit === null ? 'all its uploads' : `all ${quota.limit} of its uploads`;
      return ` YouTube counts uploads per Google app, not per channel. The Google app this account signed in with has used ${count} for today, across every account that signs in with it. It resets at ${quota.resetsAt.toISOString()} (in ${duration(wait)}): schedule one retry then, every earlier retry fails.`;
    }
    case 'insufficientPermissions':
    case 'forbidden':
      return ' The sign-in lacks upload permission: run `kortix connectors connect youtube` and sign in again.';
    default:
      return '';
  }
}

function duration(seconds: number): string {
  const total = Math.ceil(seconds / 60);
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  return hours > 0 ? `${hours} h ${minutes} min` : `${minutes} min`;
}

/** A refusal status the gateway reports: the caller's mistake, a limit, or the provider. */
function refusalStatus(status: number, reason: string | null): number {
  if (status === 429 || reason === 'quotaExceeded' || reason === 'uploadLimitExceeded' || reason === 'rateLimitExceeded') {
    return 429;
  }
  if (status === 400) return 400;
  return 502;
}

/**
 * Start the upload on the connection's account and answer how to send the
 * file. Never runs Composio's own `YOUTUBE_UPLOAD_VIDEO`.
 */
export async function startYoutubeUpload(
  session: YoutubeUploadSession,
  args: Record<string, unknown>,
  toolkit = 'youtube',
  now: () => Date = () => new Date(),
): Promise<ExecResult> {
  const request = youtubeUploadRequest(args);
  if (typeof request === 'string') return callerError(request);
  if (!session.proxyExecute) {
    return { ok: false, status: 501, data: 'composio_proxy_unavailable: this Composio client cannot start an upload' };
  }

  const response = await session.proxyExecute({
    toolkit,
    endpoint: YOUTUBE_UPLOAD_ENDPOINT,
    method: 'POST',
    body: { snippet: request.snippet, status: request.status },
    parameters: [
      { in: 'query', name: 'uploadType', value: 'resumable' },
      { in: 'query', name: 'part', value: 'snippet,status' },
      ...(request.notifySubscribers ? [] : [{ in: 'query' as const, name: 'notifySubscribers', value: 'false' }]),
      { in: 'header', name: 'Content-Type', value: 'application/json; charset=UTF-8' },
      { in: 'header', name: 'X-Upload-Content-Type', value: request.mimeType },
      ...(request.fileSize === null
        ? []
        : [{ in: 'header' as const, name: 'X-Upload-Content-Length', value: String(request.fileSize) }]),
    ],
  });

  const uploadUrl = header(response.headers, 'location');
  if (response.status < 200 || response.status >= 300 || !uploadUrl) {
    const { reason, message, quota } = googleError(response.data);
    const what = response.status >= 200 && response.status < 300 ? 'answered no upload URL' : `refused the upload (HTTP ${response.status}${reason ? `, ${reason}` : ''})`;
    const status = refusalStatus(response.status, reason);
    const at = now();
    const retryAfterSeconds = status === 429 ? secondsUntil(quota, at) : undefined;
    return {
      ok: false,
      status,
      data: {
        provider: 'composio',
        sessionId: session.sessionId,
        result: response.data ?? null,
        error: `YouTube ${what}${message ? `: ${message}` : ''}.${refusalHint(reason, quota, at)}`,
      },
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    };
  }

  const file = request.filePath ? shellQuote(request.filePath) : '<FILE>';
  const size = request.fileSize === null ? '<SIZE>' : String(request.fileSize);
  const url = shellQuote(uploadUrl);
  return {
    ok: true,
    status: 200,
    data: {
      provider: 'composio',
      sessionId: session.sessionId,
      result: {
        // The upload URL is a credential: an approved held call's stored
        // outcome leaves `caller_only` out (`CALLER_ONLY_KEY`).
        [CALLER_ONLY_KEY]: {
          upload_url: uploadUrl,
          upload_command: `curl -sS -X PUT -H ${shellQuote(`Content-Type: ${request.mimeType}`)} -T ${file} ${url}`,
          resume_status_command: `curl -sS -i -X PUT -H 'Content-Length: 0' -H ${shellQuote(`Content-Range: bytes */${size}`)} ${url}`,
        },
        video: {
          title: request.snippet.title,
          privacy_status: request.status.privacyStatus,
          ...(request.status.publishAt ? { publish_at: request.status.publishAt } : {}),
        },
        next: [
          `Run caller_only.upload_command${request.filePath ? '' : ' with <FILE> replaced by the video path'}.`,
          'It prints the video JSON: its id is the video, https://youtu.be/<id>. YouTube keeps processing it after the upload.',
          'If the upload breaks, run caller_only.resume_status_command: HTTP 308 with "Range: bytes=0-N" means resend the rest',
          'with -H "Content-Range: bytes N+1-<SIZE-1>/<SIZE>". Use this URL for this one video only.',
        ].join(' '),
      },
    },
  };
}
