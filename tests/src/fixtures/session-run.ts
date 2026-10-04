/**
 * Helpers for flows that boot a real session runtime and run turns on it.
 *
 * They speak the Kortix session routes — `POST /start`, `POST /prompts`,
 * `GET /turn`, `GET /transcript`, `GET /events` — so one flow body runs
 * unchanged on OpenCode and on pi (`harnessFlow` in core/flow.ts). Two calls
 * still go to the session runtime behind the preview proxy, because no Kortix
 * route exists for them yet: the abort the web Stop button sends
 * (`POST /session/<root>/abort`) and the daemon's own `GET /kortix/health`.
 * Both harnesses serve both.
 */
import { isKe2eRetryableError } from '../core/client';
import { waitFor } from '../core/poll';
import { markSessionReadinessTimeoutRetryable } from '../core/session-runtime-retry';
import type { CreatedProject, FlowContext, Harness } from '../core/types';

/** The preview-proxy path of a runtime route. Not a manifest route, so never in `meta.routes`. */
export function runtimePath(sandboxId: string, suffix: string): string {
  return `/v1/p/${sandboxId}/8000${suffix.startsWith('/') ? suffix : `/${suffix}`}`;
}

/**
 * `POST /stop` answers 200 `stopped` when the provider confirms inside the API's
 * 17 s budget, and 200 `stopping` when it does not (the stop then finishes in
 * the background; apps/api/src/services/sessions/lifecycle/stop.ts). Both are the
 * contract. For `stopping`, this helper waits until the stop landed: the sandbox
 * row leaves `active`, which a repeat `/stop` reports as 409 "not running".
 * `waitUntilStoppable` retries a 409 on the FIRST call while the row is still
 * settling to `active` after a boot. Returns the first 200 response.
 */
export async function stopSessionAndWait(
  ctx: FlowContext,
  projectId: string,
  sessionId: string,
  opts: { waitUntilStoppable?: boolean } = {},
): Promise<any> {
  const stop = () =>
    ctx.client.as(ctx.P.OWNER).post(
      '/v1/projects/:projectId/sessions/:sessionId/stop',
      {},
      { params: { projectId, sessionId } },
    );
  const first = opts.waitUntilStoppable
    ? await waitFor(stop, {
        until: (r) => r.statusCode !== 409,
        timeoutMs: 60_000,
        intervalMs: 3_000,
        description: `session ${sessionId} to become stoppable (stop returns 409 until the sandbox row is active)`,
        retryOnError: isKe2eRetryableError,
      })
    : await stop();
  first.status(200);
  const status = first.json<any>().status;
  if (status === 'stopping') {
    await waitFor(stop, {
      until: (r) => r.statusCode === 409,
      timeoutMs: 120_000,
      intervalMs: 3_000,
      description: `session ${sessionId} stop to land (a repeat stop returns 409 once the sandbox row is no longer active)`,
      retryOnError: isKe2eRetryableError,
    });
  } else if (status !== 'stopped') {
    throw new Error(`stop answered status ${JSON.stringify(status)}; expected "stopped" or "stopping"`);
  }
  return first;
}

/** Poll the unified session-open route until the runtime is ready. */
export async function waitForSessionReady(
  ctx: FlowContext,
  projectId: string,
  sessionId: string,
  timeoutMs = 540_000,
): Promise<any> {
  try {
    return await waitFor(
      async () => {
        const r = await ctx.client.as(ctx.P.OWNER).post(
          '/v1/projects/:projectId/sessions/:sessionId/start',
          {},
          {
            params: { projectId, sessionId },
            query: { wait_ms: '8000' },
            // The server may hold the request for the full 8s wait window, and
            // Cloudflare/ECS transit can add several more seconds under load.
            timeoutMs: 25_000,
          },
        );
        if (r.statusCode >= 500 && r.statusCode <= 599) return null;
        r.status(200);
        return r.json<any>();
      },
      {
        until: (s) =>
          s?.stage === 'ready' && Boolean(s?.sandbox?.external_id ?? s?.sandbox?.externalId),
        timeoutMs,
        intervalMs: 3_000,
        description: `session runtime ready for ${sessionId}`,
        retryOnError: isKe2eRetryableError,
      },
    );
  } catch (error) {
    throw markSessionReadinessTimeoutRetryable(error, sessionId);
  }
}

/** The preview-proxy id (`external_id`) a ready `/start` answer names. */
export function sandboxIdOf(started: any): string {
  const id = String(started?.sandbox?.external_id ?? started?.sandbox?.externalId ?? '');
  if (!id) throw new Error(`a ready session named no sandbox: ${JSON.stringify(started)}`);
  return id;
}

/**
 * The daemon's health names the harness that answers. A daemon from before
 * the shared host-health builder omits `harness` on OpenCode, so absence reads
 * as OpenCode.
 */
export async function assertRuntimeHarness(
  ctx: FlowContext,
  sandboxId: string,
  harness: Harness,
): Promise<void> {
  const r = await ctx.client.as(ctx.P.OWNER).get(runtimePath(sandboxId, '/kortix/health'));
  r.status(200);
  // Since W3 `harness` is the closed block `{ id, ... }`; W0 sent the id string.
  const named = r.json<{ harness?: string | { id?: string } }>()?.harness;
  const reported = (typeof named === 'object' ? named?.id : named) ?? 'opencode';
  if (reported !== harness) {
    throw new Error(`the session runtime is ${reported}, the flow asked for ${harness}`);
  }
}

export interface BootedSession {
  projectId: string;
  sessionId: string;
  sandboxId: string;
}

/**
 * Create a session on `harness`, wait for its runtime, prove the box runs
 * that harness, and wait until the boot prompt's turn has ended, so the flow
 * starts from an idle session and every turn it observes is its own.
 *
 * The body runs INSIDE a `ctx.step`: request capture is scoped to a step, and
 * boot is the most expensive and most failure-prone part of every flow here.
 * RUN-4 once failed on a readiness timeout with `"steps": []` — no request, no
 * `provisioningStage`, no `lastInitError` — because its polls ran outside one.
 */
export async function bootSession(
  ctx: FlowContext,
  harness: Harness,
  opts?: {
    prompt?: string;
    readinessTimeoutMs?: number;
    opencodeModel?: string;
    /** A project already on `harness`; the shared seeded one by default. */
    project?: CreatedProject;
    agentName?: string;
  },
): Promise<BootedSession> {
  return ctx.step(`a fresh ${harness} session boots to a ready runtime`, async () => {
    const project = opts?.project ?? (await ctx.fixtures.sharedSeededProject(harness));
    const session = await ctx.fixtures.session(project, {
      prompt: opts?.prompt ?? 'say hello',
      opencodeModel: opts?.opencodeModel,
      agentName: opts?.agentName,
    });
    const started = await waitForSessionReady(ctx, project.id, session.id, opts?.readinessTimeoutMs);
    const sandboxId = sandboxIdOf(started);
    await assertRuntimeHarness(ctx, sandboxId, harness);
    await waitFor(
      async () => ({
        turn: await readTurn(ctx, project.id, session.id),
        transcript: await readTranscript(ctx, project.id, session.id),
      }),
      {
        until: ({ turn, transcript }) =>
          turn.turns.length === 0 &&
          transcript.messages.some((m) => m.role === 'assistant' && (Boolean(m.completed) || Boolean(m.error))),
        timeoutMs: 240_000,
        intervalMs: 2_000,
        description: `the boot prompt's turn to end in session ${session.id}`,
        retryOnError: isKe2eRetryableError,
      },
    );
    return { projectId: project.id, sessionId: session.id, sandboxId };
  });
}

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/**
 * A wire message id the way the SDK's `mintWireMessageId` mints one without a
 * transcript: `msg_`, the low 48 bits of `(now - 2 min) * 0x1000` as 12 hex
 * chars, 14 base62 chars. The prompt route rejects anything else with 400.
 */
export function mintWireMessageId(nowMs = Date.now()): string {
  const clock = (BigInt(nowMs - 120_000) * BigInt(0x1000)) & BigInt('0xffffffffffff');
  let tail = '';
  for (let i = 0; i < 14; i++) tail += BASE62[Math.floor(Math.random() * 62)];
  return `msg_${clock.toString(16).padStart(12, '0')}${tail}`;
}

/**
 * Queue one prompt in the session's server inbox, exactly as the CLI does
 * (`apps/cli` `queueSessionPrompt`): a client that does not hold the
 * transcript mints a plain wire id and asks the server to place it at delivery
 * (`remint_on_delivery`). Resolves when the prompt is DURABLE, not delivered.
 * Returns the `prompt_id`.
 */
export async function sendPrompt(
  ctx: FlowContext,
  projectId: string,
  sessionId: string,
  text: string,
  opts?: { model?: { providerID: string; modelID: string } },
): Promise<string> {
  const r = await ctx.client.as(ctx.P.OWNER).post(
    '/v1/projects/:projectId/sessions/:sessionId/prompts',
    {
      client_message_id: crypto.randomUUID(),
      message_id: mintWireMessageId(),
      parts: [{ type: 'text', text }],
      client_sent_at_ms: Date.now(),
      remint_on_delivery: true,
      ...(opts?.model ? { overrides: { model: opts.model } } : {}),
    },
    { params: { projectId, sessionId } },
  );
  // 200 is the idempotent replay of a POST the client retried after a
  // transient edge failure (SESS-25); both name one durable row.
  r.status([200, 202]);
  const promptId = r.json<{ prompt_id?: string }>()?.prompt_id;
  if (!promptId) throw new Error(`POST /prompts returned no prompt_id: ${r.text()}`);
  return promptId;
}

/** One row of `GET /transcript` (apps/api `session-transcript-compact.ts`). */
export interface TranscriptMessage {
  id: string | null;
  parent_id: string | null;
  role: string;
  created: string | null;
  completed: string | null;
  text: string;
  /** The message's tool calls: name and final state (`completed`, `error`, …). */
  tools?: Array<{ tool: string; status: string | null }>;
  error: { name?: string; message?: string } | null;
}

export interface Transcript {
  available: boolean;
  source: 'live' | 'mirror' | 'none';
  reason: string | null;
  opencode_session_id: string | null;
  messages: TranscriptMessage[];
}

export async function readTranscript(
  ctx: FlowContext,
  projectId: string,
  sessionId: string,
): Promise<Transcript> {
  const r = await ctx.client
    .as(ctx.P.OWNER)
    .get('/v1/projects/:projectId/sessions/:sessionId/transcript', {
      params: { projectId, sessionId },
      query: { limit: '200' },
    });
  r.status(200);
  const body = r.json<Transcript>();
  return { ...body, messages: Array.isArray(body?.messages) ? body.messages : [] };
}

/** The error names a runtime stamps on an ABORTED turn: the "Interrupted" marker. */
export const ABORT_ERROR_NAMES = ['AbortError', 'MessageAbortedError'];

export function isAbortStamp(m: TranscriptMessage): boolean {
  return m.role === 'assistant' && ABORT_ERROR_NAMES.includes(m.error?.name ?? '');
}

/**
 * `Invalid error response format: Gateway request failed` reads like a gateway
 * bug and is not one. Both halves are HARDCODED by `@ai-sdk/gateway`: it emits
 * `Invalid error response format: ${defaultMessage}` when a non-2xx body fails
 * its `{ error: { message: string } }` schema, and `defaultMessage` is the
 * constant `'Gateway request failed'`. On a deployed target the body that
 * fails that schema is the `api-router` Cloudflare Worker's maintenance
 * response (`infra/cloudflare/workers/api-router/worker.mjs:157`), which it
 * substitutes for ANY origin 502/503/504 and which spells `error` as a string.
 * So this signature means "the edge swallowed an origin 5xx". Say that in the
 * failure text instead of spending another triage cycle on it.
 */
function decodeOpaqueGatewayError(detail: string): string {
  if (!detail.includes('Invalid error response format')) return '';
  return (
    ' — NOTE: @ai-sdk/gateway emits this string when an error body fails its' +
    ' {error:{message}} schema; it carries NO information about the real failure.' +
    ' On a deployed target that body is the api-router Worker maintenance response' +
    ' substituted for an origin 502/503/504 (infra/cloudflare/workers/api-router/worker.mjs:157).' +
    ' Read X-Origin-Status / X-Request-Id at the edge to recover the origin error.'
  );
}

/**
 * A turn that ended on a provider or gateway error can never produce the
 * expected text, so waiting out the budget only turns a diagnosable upstream
 * failure into a misleading timeout. Its own class so `waitFor` does not
 * swallow it, and marked retryable so the runner spends an INFRA attempt on
 * it: a transient upstream outage is what a retry is for, and a persistent one
 * still fails the flow, by name.
 */
class TerminalTurnError extends Error {
  readonly ke2eRetryable = true;
  readonly ke2eRetryClass = 'infra';
  constructor(message: string) {
    super(message);
    this.name = 'TerminalTurnError';
  }
}

/**
 * Poll `GET /transcript` until an assistant message contains `marker`.
 *
 * Fails at once when an assistant message ends on a non-abort error that is
 * not in `knownErrorIds` (errors that predate this wait).
 */
export async function waitForAssistantText(
  ctx: FlowContext,
  projectId: string,
  sessionId: string,
  marker: string,
  opts?: { timeoutMs?: number; knownErrorIds?: Set<string> },
): Promise<TranscriptMessage[]> {
  const known = opts?.knownErrorIds ?? new Set<string>();
  const transcript = await waitFor(
    async () => {
      const read = await readTranscript(ctx, projectId, sessionId);
      const dead = read.messages.find(
        (m) =>
          m.role === 'assistant' &&
          m.error?.name &&
          !ABORT_ERROR_NAMES.includes(m.error.name) &&
          !(m.id && known.has(m.id)),
      );
      if (dead) {
        const detail = dead.error?.message ?? '';
        throw new TerminalTurnError(
          `the assistant turn ended on a NON-abort runtime error, so "${marker}" can never appear: ` +
            `${dead.error?.name}${detail ? `: ${detail}` : ''} (message ${dead.id ?? '?'})` +
            decodeOpaqueGatewayError(detail),
        );
      }
      return read;
    },
    {
      until: (read) =>
        read.messages.some((m) => m.role === 'assistant' && m.text.includes(marker)),
      timeoutMs: opts?.timeoutMs ?? 240_000,
      intervalMs: 4_000,
      description: `an assistant reply containing "${marker}" in session ${sessionId}`,
      // A laundered edge 503 mid-wait is transit, not a verdict. The
      // terminal-turn verdict above is one, so it is never ridden out.
      retryOnError: (error) => !(error instanceof TerminalTurnError) && isKe2eRetryableError(error),
    },
  );
  return transcript.messages;
}

/** The ids of assistant messages that already carry an error. */
export function erroredMessageIds(messages: TranscriptMessage[]): Set<string> {
  return new Set(
    messages.filter((m) => m.role === 'assistant' && m.error?.name && m.id).map((m) => m.id!),
  );
}

/** `GET /turn`: the turns running now, and how the last one ended. */
export interface TurnState {
  turns: Array<{ turn_token: string; state: 'delivering' | 'active'; message_id: string | null }>;
  last_ended?: { turn_token: string; end_reason: string | null; ended_at: string | null };
}

export async function readTurn(
  ctx: FlowContext,
  projectId: string,
  sessionId: string,
): Promise<TurnState> {
  const r = await ctx.client
    .as(ctx.P.OWNER)
    .get('/v1/projects/:projectId/sessions/:sessionId/turn', { params: { projectId, sessionId } });
  r.status(200);
  return r.json<TurnState>();
}

/** Poll `GET /turn` until `until` holds. */
export async function waitForTurn(
  ctx: FlowContext,
  projectId: string,
  sessionId: string,
  until: (turn: TurnState) => boolean,
  description: string,
  timeoutMs = 240_000,
): Promise<TurnState> {
  return waitFor(() => readTurn(ctx, projectId, sessionId), {
    until,
    timeoutMs,
    intervalMs: 1_000,
    description,
    retryOnError: isKe2eRetryableError,
  });
}

/** No turn runs, and the last one ended with a token other than `previousToken`. */
export function endedAfter(previousToken: string | undefined) {
  return (turn: TurnState): boolean =>
    turn.turns.length === 0 &&
    Boolean(turn.last_ended?.turn_token) &&
    turn.last_ended?.turn_token !== previousToken;
}

export interface SseFrame {
  event: string;
  data: string;
}

/**
 * Open `GET /events`, run `action` once the stream says hello, and read
 * frames until `done(frames)` holds. Raw fetch, not `ctx.client`: the stream
 * never ends, so a buffered read would hang the flow.
 */
export async function watchSessionEvents(
  ctx: FlowContext,
  projectId: string,
  sessionId: string,
  action: () => Promise<void>,
  done: (frames: SseFrame[]) => boolean,
  timeoutMs = 180_000,
): Promise<SseFrame[]> {
  const auth = (ctx.P.OWNER as { auth?: { token?: string; ensureFresh?: () => Promise<void> } }).auth;
  await auth?.ensureFresh?.();
  if (!auth?.token) throw new Error('the OWNER principal has no bearer token');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const frames: SseFrame[] = [];
  try {
    const response = await fetch(`${ctx.env.apiUrl}/projects/${projectId}/sessions/${sessionId}/events`, {
      headers: { accept: 'text/event-stream', authorization: `Bearer ${auth.token}` },
      signal: controller.signal,
    });
    if (response.status !== 200) throw new Error(`GET /events answered ${response.status}`);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let acted = false;
    for (;;) {
      const { done: ended, value } = await reader.read();
      if (ended) throw new Error('the event stream ended');
      buffer += decoder.decode(value, { stream: true });
      for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
        const lines = buffer.slice(0, end).split('\n');
        buffer = buffer.slice(end + 2);
        frames.push({
          event: lines.find((line) => line.startsWith('event: '))?.slice(7) ?? 'message',
          data: lines.filter((line) => line.startsWith('data: ')).map((line) => line.slice(6)).join('\n'),
        });
      }
      if (!acted && frames.some((frame) => frame.event === 'kortix.stream.hello')) {
        acted = true;
        await action();
      }
      if (acted && done(frames)) return frames;
    }
  } catch (error) {
    if (!controller.signal.aborted) throw error;
    const seen = [...new Set(frames.map((frame) => frame.event))].join(', ');
    throw new Error(`GET /events did not satisfy the flow within ${timeoutMs} ms; frame types seen: ${seen}`);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

/**
 * The text of every assistant reply part the stream carried: for each part,
 * its last full `text` and its deltas joined in stream order (pi puts only
 * deltas on the stream). User parts do not count, and neither do control
 * frames: the inbox echoes the prompt text, marker included.
 */
export function streamedReplies(frames: SseFrame[]): string[] {
  const assistant = new Set<string>();
  const parts = new Map<string, { messageId: string; text: string; deltas: string }>();
  const part = (id: string, messageId: string) => {
    const known = parts.get(id) ?? { messageId, text: '', deltas: '' };
    parts.set(id, known);
    return known;
  };
  for (const frame of frames) {
    let data: any;
    try {
      data = JSON.parse(frame.data);
    } catch {
      continue;
    }
    if (data?.channel !== 'runtime') continue;
    const body = data.payload ?? {};
    if (data.type === 'message.updated' && body.info?.role === 'assistant' && body.info.id) {
      assistant.add(body.info.id);
    } else if (data.type === 'message.part.updated' && body.part?.id && typeof body.part.text === 'string') {
      part(body.part.id, body.part.messageID).text = body.part.text;
    } else if (data.type === 'message.part.delta' && body.partID && typeof body.delta === 'string') {
      part(body.partID, body.messageID).deltas += body.delta;
    }
  }
  return [...parts.values()]
    .filter((p) => assistant.has(p.messageId))
    .flatMap((p) => [p.text, p.deltas]);
}

/** The root conversation the server pinned for this session (`opencode_session_id`). */
export async function pinnedRoot(
  ctx: FlowContext,
  projectId: string,
  sessionId: string,
): Promise<string> {
  const row = await waitFor(
    async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/projects/:projectId/sessions/:sessionId', { params: { projectId, sessionId } });
      r.status(200);
      return r.json<{ opencode_session_id?: string | null }>();
    },
    {
      until: (s) => typeof s?.opencode_session_id === 'string' && s.opencode_session_id.length > 0,
      timeoutMs: 60_000,
      intervalMs: 2_000,
      description: `a pinned root conversation for session ${sessionId}`,
      retryOnError: isKe2eRetryableError,
    },
  );
  return row.opencode_session_id!;
}

/**
 * Stop the running turn the way the web Stop button does: the SDK's runtime
 * `session.abort()`, i.e. `POST /session/<root>/abort` on the session runtime.
 * No Kortix abort route exists yet (OpenCode decoupling plan, task E1).
 */
export async function abortTurn(ctx: FlowContext, session: BootedSession): Promise<void> {
  const root = await pinnedRoot(ctx, session.projectId, session.sessionId);
  const r = await ctx.client
    .as(ctx.P.OWNER)
    .post(runtimePath(session.sandboxId, `/session/${root}/abort`), {});
  r.status([200, 204]);
}
