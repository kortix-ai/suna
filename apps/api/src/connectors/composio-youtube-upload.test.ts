import { describe, expect, test } from 'bun:test';
import { buildArgsPreviewDetails } from './args-preview';
import { executeComposio, type ComposioRuntime, type ComposioSessionLike } from './composio';
import {
  type ComposioProxyRequest,
  type ComposioProxyResponse,
  YOUTUBE_UPLOAD_ENDPOINT,
  YOUTUBE_UPLOAD_TOOL,
  shellQuote,
  youtubeUploadRequest,
} from './composio-youtube-upload';
import { callerOnlyText, heldRunResumeText, withoutCallerOnly } from './held-call-run';
import { normalizeComposio } from './normalize';

const SESSION_URI =
  'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet%2Cstatus&upload_id=ADPycdu1-synthetic-upload-id-0123456789abcdefghijklmnopqrstuvwxyz';

/** A resumed Tool Router session on an active YouTube account, recording what it is asked. */
function youtubeSession(input: {
  proxy?: (request: ComposioProxyRequest) => Promise<ComposioProxyResponse>;
  active?: boolean;
  executed?: string[];
  proxied?: ComposioProxyRequest[];
}): ComposioSessionLike {
  return {
    sessionId: 'persisted-session',
    async tools() {
      return [];
    },
    async toolkits() {
      return {
        items: [
          {
            slug: 'youtube',
            name: 'YouTube',
            isNoAuth: false,
            connection: {
              isActive: input.active ?? true,
              connectedAccount: { id: 'ca_youtube', status: input.active === false ? 'EXPIRED' : 'ACTIVE' },
            },
          },
        ],
        cursor: undefined,
        totalPages: 1,
      } as Awaited<ReturnType<ComposioSessionLike['toolkits']>>;
    },
    async authorize() {
      throw new Error('not used');
    },
    async execute(slug) {
      input.executed?.push(slug);
      return { data: {}, error: null, logId: 'log-1' };
    },
    async proxyExecute(request) {
      input.proxied?.push(request);
      return (input.proxy ?? (async () => ({ status: 200, data: '', headers: { location: SESSION_URI } })))(request);
    },
  };
}

function runtimeFor(session: ComposioSessionLike): ComposioRuntime {
  return {
    sessions: {
      async create() {
        return session;
      },
      async use() {
        return session;
      },
    },
  };
}

const upload = (session: ComposioSessionLike, args: Record<string, unknown>) =>
  executeComposio({
    projectId: 'project-1',
    connectorSlug: 'youtube',
    connectionId: 'connection-1',
    sessionId: 'persisted-session',
    toolkit: 'youtube',
    toolSlug: YOUTUBE_UPLOAD_TOOL,
    args,
    connectedAccountId: 'ca_youtube',
    runtime: runtimeFor(session),
  });

describe('youtube.upload_video in the connector actions', () => {
  test("replaces Composio's path-based YOUTUBE_UPLOAD_VIDEO and keeps every other tool", () => {
    const actions = normalizeComposio(
      [
        { type: 'function', function: { name: 'YOUTUBE_UPLOAD_VIDEO', description: 'Uploads a video from a local file path' } },
        { type: 'function', function: { name: 'YOUTUBE_MULTIPART_UPLOAD_VIDEO', description: 'Multipart upload' } },
      ],
      'youtube',
    );
    expect(actions.map((action) => action.path)).toEqual(['multipart_upload_video', 'upload_video']);
    const own = actions.find((action) => action.path === 'upload_video')!;
    expect(own.description).toStartWith('Upload a video file from this session');
    expect(own.binding).toEqual({ kind: 'composio', toolkit: 'youtube', toolSlug: 'YOUTUBE_UPLOAD_VIDEO' });
    expect(own.inputSchema?.required).toEqual(['title']);
    expect(own.risk).toBe('write');
  });

  test('another toolkit gets no Kortix tool', () => {
    const actions = normalizeComposio([{ type: 'function', function: { name: 'GMAIL_SEND_EMAIL' } }], 'gmail');
    expect(actions.map((action) => action.path)).toEqual(['send_email']);
  });
});

describe('youtube.upload_video starts a resumable upload on the connection', () => {
  test('one proxied POST with the metadata; the answer is the upload URL and a ready curl command', async () => {
    const proxied: ComposioProxyRequest[] = [];
    const executed: string[] = [];
    const result = await upload(youtubeSession({ proxied, executed }), {
      title: 'Launch demo',
      description: 'What we shipped',
      tags: ['kortix', 'demo'],
      category_id: '28',
      privacy_status: 'unlisted',
      contains_synthetic_media: true,
      notify_subscribers: false,
      file_path: "/workspace/output/it's here.mp4",
      file_size: 52_428_800,
      mime_type: 'video/mp4',
    });

    expect(executed).toEqual([]);
    expect(proxied).toEqual([
      {
        toolkit: 'youtube',
        endpoint: YOUTUBE_UPLOAD_ENDPOINT,
        method: 'POST',
        body: {
          snippet: { title: 'Launch demo', description: 'What we shipped', tags: ['kortix', 'demo'], categoryId: '28' },
          status: { privacyStatus: 'unlisted', containsSyntheticMedia: true },
        },
        parameters: [
          { in: 'query', name: 'uploadType', value: 'resumable' },
          { in: 'query', name: 'part', value: 'snippet,status' },
          { in: 'query', name: 'notifySubscribers', value: 'false' },
          { in: 'header', name: 'Content-Type', value: 'application/json; charset=UTF-8' },
          { in: 'header', name: 'X-Upload-Content-Type', value: 'video/mp4' },
          { in: 'header', name: 'X-Upload-Content-Length', value: '52428800' },
        ],
      },
    ]);
    expect(result.ok).toBe(true);
    const data = result.data as { provider: string; result: Record<string, unknown> };
    expect(data.provider).toBe('composio');
    expect(data.result.caller_only).toEqual({
      upload_url: SESSION_URI,
      upload_command: `curl -sS -X PUT -H 'Content-Type: video/mp4' -T '/workspace/output/it'"'"'s here.mp4' '${SESSION_URI}'`,
      resume_status_command: `curl -sS -i -X PUT -H 'Content-Length: 0' -H 'Content-Range: bytes */52428800' '${SESSION_URI}'`,
    });
    expect(data.result.video).toEqual({ title: 'Launch demo', privacy_status: 'unlisted' });
  });

  test('defaults: private, subscribers notified, video/*, and a <FILE> placeholder', async () => {
    const proxied: ComposioProxyRequest[] = [];
    const result = await upload(youtubeSession({ proxied }), { title: 'Draft' });
    expect(proxied[0]!.body).toEqual({ snippet: { title: 'Draft' }, status: { privacyStatus: 'private' } });
    expect(proxied[0]!.parameters!.map((p) => p.name)).toEqual(['uploadType', 'part', 'Content-Type', 'X-Upload-Content-Type']);
    const command = (result.data as { result: { caller_only: { upload_command: string } } }).result.caller_only.upload_command;
    expect(command).toBe(`curl -sS -X PUT -H 'Content-Type: video/*' -T <FILE> '${SESSION_URI}'`);
  });

  test('a header name in any case is the upload URL', async () => {
    const result = await upload(
      youtubeSession({ proxy: async () => ({ status: 200, data: '', headers: { Location: SESSION_URI } }) }),
      { title: 'Draft' },
    );
    expect((result.data as { result: { caller_only: { upload_url: string } } }).result.caller_only.upload_url).toBe(SESSION_URI);
  });

  test('an approved held upload: reviewers see the video, only the calling session gets the URL', async () => {
    const result = await upload(youtubeSession({}), { title: 'Held', file_path: '/workspace/v.mp4' });
    const output = (result.data as { result: unknown }).result;
    // What the held call stores for reviewers: no caller_only, no URL.
    const stored = JSON.stringify(buildArgsPreviewDetails({ output: withoutCallerOnly(output) }).preview);
    expect(stored).toContain('"title":"Held"');
    expect(stored).not.toContain('upload_id');
    expect(stored).not.toContain('"caller_only":');
    expect(stored).not.toContain('curl ');
    // What the resume prompt gives the calling session: the ready command.
    const resume = heldRunResumeText('youtube.upload_video', { status: 'ok', output_preview: stored }, callerOnlyText(output));
    expect(resume).toContain(`-T '/workspace/v.mp4' '${SESSION_URI}'`);
    expect(resume).toContain('caller_only (for you only, not shown to reviewers)');
  });
});

describe('youtube.upload_video refusals', () => {
  test('bad arguments are the caller\'s mistake and reach no API', async () => {
    const proxied: ComposioProxyRequest[] = [];
    const session = youtubeSession({ proxied });
    const refused = async (args: Record<string, unknown>) => {
      const result = await upload(session, args);
      expect(result).toMatchObject({ ok: false, status: 400 });
      return result.data;
    };
    expect(await refused({})).toBe('title is required');
    expect(await refused({ title: 'x'.repeat(101) })).toBe('title is 101 characters; YouTube allows 100');
    expect(await refused({ title: 'a <b>' })).toBe('title must not contain < or >');
    expect(await refused({ title: 'ok', privacy_status: 'friends' })).toBe('privacy_status must be one of private, unlisted, public');
    expect(await refused({ title: 'ok', publish_at: '2999-01-01T00:00:00Z', privacy_status: 'public' })).toStartWith(
      'publish_at needs privacy_status private',
    );
    expect(await refused({ title: 'ok', publish_at: '2000-01-01T00:00:00Z' })).toBe('publish_at must be in the future');
    expect(await refused({ title: 'ok', file_size: 0 })).toBe('file_size must be a positive whole number of bytes');
    expect(await refused({ title: 'ok', mime_type: 'image/png' })).toBe('mime_type must be a video type such as video/mp4');
    expect(await refused({ title: 'ok', mime_type: 5 })).toBe('mime_type must be a string such as video/mp4');
    expect(await refused({ title: 'ok', category_id: 'music' })).toStartWith('category_id must be a numeric');
    expect(await refused({ title: 'ok', made_for_kids: 'no' })).toBe('made_for_kids must be true or false');
    expect(proxied).toEqual([]);
  });

  test('a schedule is sent as YouTube\'s publishAt on a private video', () => {
    const request = youtubeUploadRequest({ title: 'Later', publish_at: '2030-05-01T10:00:00+02:00' }, Date.parse('2026-11-04T00:00:00Z'));
    expect(request).toMatchObject({ status: { privacyStatus: 'private', publishAt: '2030-05-01T08:00:00.000Z' } });
  });

  test('a Google account with no channel names the fix', async () => {
    const result = await upload(
      youtubeSession({
        proxy: async () => ({
          status: 401,
          data: { error: { code: 401, message: 'Unauthorized', errors: [{ reason: 'youtubeSignupRequired' }] } },
          headers: {},
        }),
      }),
      { title: 'Draft' },
    );
    expect(result.ok).toBe(false);
    expect(result.status).toBe(502);
    expect((result.data as { error: string }).error).toBe(
      'YouTube refused the upload (HTTP 401, youtubeSignupRequired): Unauthorized. This Google account has no YouTube channel: create one at https://www.youtube.com/create_channel, then retry.',
    );
  });

  test('a used-up daily quota is a 429', async () => {
    const result = await upload(
      youtubeSession({
        proxy: async () => ({
          status: 403,
          data: { error: { code: 403, message: 'quota', errors: [{ reason: 'quotaExceeded' }] } },
        }),
      }),
      { title: 'Draft' },
    );
    expect(result).toMatchObject({ ok: false, status: 429 });
  });

  test('a 2xx with no upload URL is a provider failure', async () => {
    const result = await upload(youtubeSession({ proxy: async () => ({ status: 200, data: {}, headers: {} }) }), {
      title: 'Draft',
    });
    expect(result).toMatchObject({ ok: false, status: 502 });
    expect((result.data as { error: string }).error).toBe('YouTube answered no upload URL.');
  });

  test('an inactive sign-in is refused before any upload starts', async () => {
    const proxied: ComposioProxyRequest[] = [];
    await expect(upload(youtubeSession({ proxied, active: false }), { title: 'Draft' })).rejects.toThrow(
      'composio_connection_not_active',
    );
    expect(proxied).toEqual([]);
  });
});

test('shellQuote makes one POSIX word', () => {
  expect(shellQuote("a b'c")).toBe(`'a b'"'"'c'`);
});
