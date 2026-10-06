/**
 * Kortix Capture on the hosted MCP server: read-only tools that hand a Kortix
 * agent the recorded data to process. Capture has no chat of its own; an agent
 * with this server attached is how people ask questions about it.
 *
 * Every tool is one REST route under `/v1/accounts/:accountId/capture`, called
 * in-process as the signed-in person, so scoping and audit are exactly the
 * API's: a Capture member reads only their own data; a Capture admin or viewer
 * may name a member (`user_id`) or read the account (`scope: "account"`), and
 * each such read writes `capture.member_view` / `capture.account_view`.
 *
 *   capture_accounts   GET /v1/accounts + GET …/capture
 *   capture_search     GET …/capture/search
 *   capture_timeline   GET …/capture/timeline/items
 *   capture_frame      GET …/capture/frames/:frameId (+ the screenshot as an image)
 *   capture_episodes   GET …/capture/episodes
 *   capture_episode    GET …/capture/episodes/:episodeId
 *   capture_workflows  GET …/capture/workflows
 *   capture_workflow   GET …/capture/workflows/:workflowId
 *   capture_export     POST/GET …/capture/exports[/:exportId]
 */
import type { Host } from './connectors';

// The transport's types, through the host (this module must not import the MCP http layer).
type ApiReply = Awaited<ReturnType<Host['call']>>;
type ToolResult = ReturnType<Host['text']>;

const ACCOUNT_ID = { type: 'string', description: 'The Kortix account (organization) id, from capture_accounts.' } as const;
const USER_ID = {
  type: 'string',
  description: "A member's user_id. Capture admins and viewers only (audited as capture.member_view); omit it to read your own data.",
} as const;
const SCOPE = {
  type: 'string',
  enum: ['mine', 'account'],
  description: '"account": every member (Capture admins and viewers only; audited as capture.account_view). Default "mine".',
} as const;
const FROM = { type: 'string', description: 'ISO time, inclusive.' } as const;
const TO = { type: 'string', description: 'ISO time, exclusive.' } as const;
const READ = { readOnlyHint: true, openWorldHint: false } as const;

/** Per-item text is cut to this, so a page of frames or hits stays readable. */
export const MAX_TEXT = 400;
/** The image a frame tool returns: at most this many bytes. */
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

export const CAPTURE_TOOLS = [
  {
    name: 'capture_accounts',
    title: 'Kortix Capture: accounts',
    description:
      'List your Kortix accounts with Kortix Capture: account_id, name, whether Capture is on, and your Capture role (admin and viewer read every member; member reads only their own recordings). Start here: every capture_* tool takes an account_id.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: READ,
  },
  {
    name: 'capture_search',
    title: 'Kortix Capture: search',
    description:
      'Full-text search over what was on screen (app, window title, URL, on-screen text; one hit per video chunk and window), what was done (clicks, typing, hotkeys) and what was said (audio transcript). Newest first. Each hit: kind, id (a frame_id for screen hits: open it with capture_frame), ts, user_id, device_id, app, title, snippet.',
    inputSchema: {
      type: 'object',
      properties: {
        account_id: ACCOUNT_ID,
        query: { type: 'string', description: 'Words to find; "a or b" for either, "-word" to exclude.' },
        kinds: { type: 'array', items: { type: 'string', enum: ['screen', 'actions', 'audio'] }, description: 'Default all three.' },
        app: { type: 'string', description: 'Only this app (exact name, any case).' },
        device_id: { type: 'string' },
        user_id: USER_ID,
        scope: SCOPE,
        from: FROM,
        to: TO,
        limit: { type: 'number', description: 'Hits to return (default 20, max 50).' },
      },
      required: ['account_id', 'query'],
      additionalProperties: false,
    },
    annotations: READ,
  },
  {
    name: 'capture_timeline',
    title: 'Kortix Capture: timeline',
    description:
      "One person's recorded activity in a time window (at most 31 days; at most 500 each of frames, actions and audio lines, oldest first): frames (ts, app, window title, URL, on-screen text cut to 400 characters), actions (ts, kind, app, window, description, screenshot) and audio lines. Narrow the window to read more detail.",
    inputSchema: {
      type: 'object',
      properties: { account_id: ACCOUNT_ID, from: FROM, to: TO, user_id: USER_ID, device_id: { type: 'string' } },
      required: ['account_id', 'from', 'to'],
      additionalProperties: false,
    },
    annotations: READ,
  },
  {
    name: 'capture_frame',
    title: 'Kortix Capture: frame',
    description:
      'One screen frame: app, window title, URL, the full on-screen text, a signed URL of its video chunk with the offset to seek to (valid 5 minutes), and the nearest action screenshot (within 30 s) as an image.',
    inputSchema: {
      type: 'object',
      properties: { account_id: ACCOUNT_ID, frame_id: { type: 'string', description: 'From capture_search (a screen hit) or capture_timeline.' }, user_id: USER_ID },
      required: ['account_id', 'frame_id'],
      additionalProperties: false,
    },
    annotations: READ,
  },
  {
    name: 'capture_episodes',
    title: 'Kortix Capture: episodes',
    description:
      'Episodes, newest first: one task by one person (label, goal, outcome, outcome_status, apps, duration, steps_count, workflow_id and variant_key when it is a run of a mined workflow). Pages: pass next_cursor back as cursor.',
    inputSchema: {
      type: 'object',
      properties: {
        account_id: ACCOUNT_ID,
        scope: SCOPE,
        user_id: USER_ID,
        device_id: { type: 'string' },
        workflow_id: { type: 'string', description: 'Only runs of this workflow.' },
        from: FROM,
        to: TO,
        cursor: { type: 'string', description: 'next_cursor of the previous page.' },
        limit: { type: 'number', description: 'Episodes per page (default 50, max 100).' },
      },
      required: ['account_id'],
      additionalProperties: false,
    },
    annotations: READ,
  },
  {
    name: 'capture_episode',
    title: 'Kortix Capture: episode',
    description: 'One episode with its ordered steps: verb, app, object, params, the names of the values that vary per run (variables), and the frame and action each step was traced from.',
    inputSchema: {
      type: 'object',
      properties: { account_id: ACCOUNT_ID, episode_id: { type: 'string' } },
      required: ['account_id', 'episode_id'],
      additionalProperties: false,
    },
    annotations: READ,
  },
  {
    name: 'capture_workflows',
    title: 'Kortix Capture: workflows',
    description:
      'Workflows mined across people and weeks (Capture admins and viewers): name, goal, status (detected, reviewed, exported), runs per week, typical and slow duration (p50/p90 s), people, apps, success rate, determinism and automation_hours_per_week (runs/week × p50 × determinism). Pages by offset.',
    inputSchema: {
      type: 'object',
      properties: {
        account_id: ACCOUNT_ID,
        status: { type: 'string', enum: ['detected', 'reviewed', 'exported'] },
        query: { type: 'string', description: 'Words in the name, goal or steps.' },
        app: { type: 'string' },
        user_id: { type: 'string', description: 'Only workflows this member runs.' },
        sort: { type: 'string', enum: ['hours', 'runs', 'newest'], description: 'Default hours (automation score).' },
        limit: { type: 'number', description: 'Default 20, max 50.' },
        offset: { type: 'number' },
      },
      required: ['account_id'],
      additionalProperties: false,
    },
    annotations: READ,
  },
  {
    name: 'capture_workflow',
    title: 'Kortix Capture: workflow',
    description:
      'One workflow (Capture admins and viewers): its standard steps, variants (name, share of runs, the steps where they differ, the condition that leads to them), the people who run it (user_id, email, runs, typical duration) and its stats.',
    inputSchema: {
      type: 'object',
      properties: { account_id: ACCOUNT_ID, workflow_id: { type: 'string' } },
      required: ['account_id', 'workflow_id'],
      additionalProperties: false,
    },
    annotations: READ,
  },
  {
    name: 'capture_export',
    title: 'Kortix Capture: bulk export',
    description:
      'Bulk export of episodes, steps and workflows for processing outside (Capture admins). Without export_id: starts one (JSONL with any tables, or Parquet with exactly one) and waits up to 20 s. With export_id: reads it. When done, download.url is a signed URL valid for 1 hour.',
    inputSchema: {
      type: 'object',
      properties: {
        account_id: ACCOUNT_ID,
        export_id: { type: 'string', description: 'Read this export instead of starting one.' },
        format: { type: 'string', enum: ['jsonl', 'parquet'], description: 'Default jsonl.' },
        include: { type: 'array', items: { type: 'string', enum: ['episodes', 'steps', 'workflows'] }, description: 'Tables; Parquet takes exactly one. Default all (jsonl) or episodes (parquet).' },
        from: FROM,
        to: TO,
      },
      required: ['account_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
] as const;

const NAMES = new Set<string>(CAPTURE_TOOLS.map((t) => t.name));
export const isCaptureTool = (name: string) => NAMES.has(name);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function id(h: Host, input: Record<string, unknown>, key: string): string {
  const value = h.arg(input, key);
  if (!UUID.test(value)) throw h.input(`${key} must be a UUID`);
  return value;
}

const bounded = (value: unknown, fallback: number, max: number) => Math.min(Math.max(Math.floor(Number(value) || fallback), 1), max);
const cut = (value: unknown, max = MAX_TEXT) => (typeof value === 'string' && value.length > max ? `${value.slice(0, max)}…` : value);

/** A refusal the agent can act on: Capture off, a scope it may not read, or the API's own text. */
export function captureError(r: ApiReply): string | null {
  if (r.status < 400) return null;
  let body: { code?: string; error?: string } = {};
  try {
    body = JSON.parse(r.body);
  } catch {
    /* not JSON */
  }
  if (body.code === 'capture_disabled') return 'Kortix Capture is off for this account. An account owner or admin turns it on in Kortix (Capture → Settings).';
  if (body.code === 'capture_forbidden') {
    return `${body.error ?? 'Not allowed'}. A Capture member reads only their own recordings: omit user_id and scope. Reading other members or the whole account needs the Capture admin or viewer role.`;
  }
  return null;
}

function reply(h: Host, r: ApiReply, shape?: (body: any) => unknown): ToolResult {
  const refused = captureError(r);
  if (refused) return h.text(`HTTP ${r.status}: ${refused}`, true);
  if (r.status >= 400) return h.apiResult(r);
  const body = r.body ? JSON.parse(r.body) : null;
  return h.text(JSON.stringify(shape ? shape(body) : body, null, 1));
}

const base = (accountId: string) => `/v1/accounts/${accountId}/capture`;

/** user_id → email from the account's member directory (every member of the account sees it). */
async function emails(h: Host, accountId: string): Promise<Map<string, string | null>> {
  const r = await h.call('GET', `/v1/accounts/${accountId}/members`);
  if (r.status >= 400) return new Map();
  const rows = JSON.parse(r.body) as Array<{ user_id: string; email: string | null }>;
  return new Map(rows.map((m) => [m.user_id, m.email]));
}

export async function runCaptureTool(name: string, input: Record<string, unknown>, h: Host): Promise<ToolResult> {
  if (name === 'capture_accounts') {
    const r = await h.call('GET', '/v1/accounts');
    if (r.status >= 400) return h.apiResult(r);
    const parsed = JSON.parse(r.body);
    const accounts = (Array.isArray(parsed) ? parsed : (parsed.accounts ?? [])) as Array<{ account_id: string; name?: string }>;
    const rows = await Promise.all(
      accounts.map(async (a) => {
        const w = await h.call('GET', base(a.account_id));
        const ws = w.status < 400 ? (JSON.parse(w.body) as { enabled: boolean; role: string }) : null;
        return { account_id: a.account_id, name: a.name ?? null, capture_enabled: ws?.enabled ?? false, capture_role: ws?.role ?? null };
      }),
    );
    return h.text(JSON.stringify(rows, null, 1));
  }
  const accountId = id(h, input, 'account_id');
  const userId = h.optionalArg(input, 'user_id');
  if (userId && !UUID.test(userId)) throw h.input('user_id must be a UUID');
  const scope = h.optionalArg(input, 'scope');
  if (scope && scope !== 'mine' && scope !== 'account') throw h.input('scope must be mine or account');
  const window = { from: h.optionalArg(input, 'from'), to: h.optionalArg(input, 'to') };

  switch (name) {
    case 'capture_search': {
      const kinds = input.kinds;
      if (kinds !== undefined && (!Array.isArray(kinds) || !kinds.every((k) => k === 'screen' || k === 'actions' || k === 'audio'))) {
        throw h.input('kinds is a list of screen, actions, audio');
      }
      const query = h.arg(input, 'query');
      if (query.length > 500) throw h.input('query is at most 500 characters');
      const r = await h.call('GET', `${base(accountId)}/search`, {
        query: { q: query, kinds: Array.isArray(kinds) ? kinds.join(',') : undefined, app: h.optionalArg(input, 'app'), device_id: h.optionalArg(input, 'device_id'), user_id: userId, scope, ...window, limit: bounded(input.limit, 20, 50) },
      });
      return reply(h, r, (b) => ({ q: b.q, hits: (b.hits as any[]).map((hit) => ({ ...hit, snippet: cut(hit.snippet) })) }));
    }
    case 'capture_timeline': {
      if (!window.from || !window.to) throw h.input('from and to are required (ISO times, at most 31 days apart)');
      const r = await h.call('GET', `${base(accountId)}/timeline/items`, { query: { ...window, user_id: userId, device_id: h.optionalArg(input, 'device_id') } });
      return reply(h, r, (b) => ({
        frames: (b.frames as any[]).map(({ ocr_boxes: _boxes, ocr_text, ...f }) => ({ ...f, text: cut(ocr_text) })),
        actions: b.actions,
        audio: (b.audio as any[]).map((a) => ({ ...a, text: cut(a.text) })),
        capped: (b.frames as any[]).length >= 500 || (b.actions as any[]).length >= 500 || (b.audio as any[]).length >= 500 ? 'At least one list holds 500 rows: narrow the window for the rest.' : undefined,
      }));
    }
    case 'capture_frame': {
      const r = await h.call('GET', `${base(accountId)}/frames/${id(h, input, 'frame_id')}`, { query: { user_id: userId } });
      if (captureError(r) || r.status >= 400) return reply(h, r);
      const b = JSON.parse(r.body) as { frame: Record<string, unknown>; video: unknown; screenshot: { name: string; ts: string; url: string } | null };
      const { ocr_boxes: _boxes, ...frame } = b.frame;
      const result: ToolResult = h.text(JSON.stringify({ frame, video: b.video, screenshot: b.screenshot && { ts: b.screenshot.ts } }, null, 1));
      if (b.screenshot) {
        const image = await fetch(b.screenshot.url, { signal: AbortSignal.timeout(10_000) }).catch(() => null);
        const type = image?.headers.get('content-type') ?? '';
        const bytes = image?.ok ? new Uint8Array(await image.arrayBuffer()) : null;
        const mime = /^image\/(png|jpeg|webp)/.test(type) ? type.split(';')[0]! : bytes && bytes[0] === 0xff && bytes[1] === 0xd8 ? 'image/jpeg' : bytes && bytes[0] === 0x89 && bytes[1] === 0x50 ? 'image/png' : null;
        if (bytes && mime && bytes.byteLength <= MAX_IMAGE_BYTES) result.content.push({ type: 'image', data: Buffer.from(bytes).toString('base64'), mimeType: mime });
      }
      return result;
    }
    case 'capture_episodes': {
      const r = await h.call('GET', `${base(accountId)}/episodes`, {
        query: { scope, user_id: userId, device_id: h.optionalArg(input, 'device_id'), workflow_id: h.optionalArg(input, 'workflow_id'), ...window, before: h.optionalArg(input, 'cursor'), limit: bounded(input.limit, 50, 100) },
      });
      if (r.status >= 400) return reply(h, r);
      const b = JSON.parse(r.body) as { episodes: Array<Record<string, unknown> & { user_id: string }>; next_before: string | null };
      const who = scope === 'account' || userId ? await emails(h, accountId) : null;
      return h.text(JSON.stringify({ episodes: b.episodes.map((e) => ({ ...e, ...(who ? { email: who.get(e.user_id) ?? null } : {}) })), next_cursor: b.next_before }, null, 1));
    }
    case 'capture_episode':
      return reply(h, await h.call('GET', `${base(accountId)}/episodes/${id(h, input, 'episode_id')}`));
    case 'capture_workflows': {
      const r = await h.call('GET', `${base(accountId)}/workflows`, {
        query: { status: h.optionalArg(input, 'status'), q: h.optionalArg(input, 'query'), app: h.optionalArg(input, 'app'), user_id: userId, sort: h.optionalArg(input, 'sort'), limit: bounded(input.limit, 20, 50), offset: Math.max(0, Math.floor(Number(input.offset) || 0)) },
      });
      return reply(h, r);
    }
    case 'capture_workflow': {
      const r = await h.call('GET', `${base(accountId)}/workflows/${id(h, input, 'workflow_id')}`);
      if (r.status >= 400) return reply(h, r);
      const b = JSON.parse(r.body) as Record<string, unknown> & { people: Array<{ user_id: string }> };
      const who = await emails(h, accountId);
      return h.text(JSON.stringify({ ...b, people: b.people.map((p) => ({ ...p, email: who.get(p.user_id) ?? null })) }, null, 1));
    }
    case 'capture_export': {
      const exportId = h.optionalArg(input, 'export_id');
      if (exportId) return reply(h, await h.call('GET', `${base(accountId)}/exports/${id(h, input, 'export_id')}`));
      const include = input.include;
      if (include !== undefined && (!Array.isArray(include) || !include.every((t) => ['episodes', 'steps', 'workflows'].includes(String(t))))) {
        throw h.input('include is a list of episodes, steps, workflows');
      }
      const started = await h.call('POST', `${base(accountId)}/exports`, { body: { format: h.optionalArg(input, 'format') ?? 'jsonl', include, ...window } });
      if (started.status >= 400) return reply(h, started);
      const exp = JSON.parse(started.body) as { export_id: string };
      let last: ApiReply = started;
      for (let i = 0; i < 20; i++) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        last = await h.call('GET', `${base(accountId)}/exports/${exp.export_id}`);
        const status = last.status < 400 ? (JSON.parse(last.body) as { status: string }).status : 'failed';
        if (status === 'done' || status === 'failed') break;
      }
      return reply(h, last);
    }
    default:
      throw h.input(`Unknown tool: ${name}`);
  }
}
