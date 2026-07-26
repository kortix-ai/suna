/**
 * The HTTP boundary between this worker and the Kortix API.
 *
 * This process is no longer inside apps/api, so it cannot call
 * `continueSession()` in-process the way the old bridge.ts/runtime.ts did.
 * Everything here goes over the network instead, against a small contract
 * this app expects apps/api to expose (see README.md — "The apps/api
 * contract this app expects"). That contract does not exist yet; wiring it
 * up is out of scope for this app (apps/api is explicitly not touched here).
 * These calls are real and correctly shaped against that contract, so they
 * work the moment apps/api implements it.
 *
 * Every function here is defensive on purpose: a tool's `execute` must always
 * resolve to something speakable, never throw and never hang past its
 * timeout. A voice call has no error boundary except "the agent goes quiet",
 * which is worse than it saying "I couldn't reach Kortix."
 */
import type { CallContext } from './call-context';

const PROMPT_TIMEOUT_MS = 6_000;
const RUN_COMMAND_TIMEOUT_MS = 12_000;
const TURN_TIMEOUT_MS = 6_000;

type PostResult = { ok: true; data: unknown } | { ok: false; error: string };

function endpoint(ctx: CallContext, path: string): string {
  const base = ctx.kortixApiUrl.replace(/\/+$/, '');
  return `${base}/v1/projects/${encodeURIComponent(ctx.projectId)}/sessions/${encodeURIComponent(ctx.sessionId)}/voice/${path}`;
}

async function postJson(
  ctx: CallContext,
  path: string,
  body: unknown,
  timeoutMs: number,
): Promise<PostResult> {
  let res: Response;
  const url = endpoint(ctx, path);
  console.log('[voice-agent] postJson fetch ->', url, { body });
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${ctx.kortixApiToken}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    console.log('[voice-agent] postJson fetch <-', url, res.status);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `kortix api /voice/${path} unreachable: ${message}` };
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return {
      ok: false,
      error: `kortix api /voice/${path} responded ${res.status}${text ? `: ${text.slice(0, 300)}` : ''}`,
    };
  }

  const data = await res.json().catch(() => ({}));
  return { ok: true, data };
}

/**
 * Fire-and-forget hand-off to the Kortix agent session — the mirror of the
 * old `ask_kortix` → `continueSession()` call. Resolves the moment the
 * request is queued, never when Kortix finishes thinking: that answer, if
 * any, arrives later out-of-band (see inbound-replies.ts) and gets spoken
 * then, not returned from here.
 */
export async function sendPromptToKortix(
  ctx: CallContext,
  text: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const result = await postJson(ctx, 'prompt', { call_id: ctx.callId, text }, PROMPT_TIMEOUT_MS);
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

export interface RunCommandResult {
  ok: boolean;
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  timedOut?: boolean;
  error?: string;
}

/**
 * Runs a short-lived command in the session's sandbox and waits for its
 * result — unlike `sendPromptToKortix`, this DOES wait, because the whole
 * point of `run_command` is "quick check, answer directly." The client-side
 * timeout is a backstop: even if apps/api's own server-side cap misbehaves,
 * this call always resolves within `RUN_COMMAND_TIMEOUT_MS` so a single slow
 * command can never wedge the call indefinitely.
 */
export async function runCommandInSandbox(
  ctx: CallContext,
  command: string,
  cwd?: string,
): Promise<RunCommandResult> {
  const result = await postJson(
    ctx,
    'run-command',
    { call_id: ctx.callId, command, cwd },
    RUN_COMMAND_TIMEOUT_MS,
  );
  if (!result.ok) return { ok: false, error: result.error };

  const data = result.data as Record<string, unknown>;
  return {
    ok: true,
    stdout: typeof data.stdout === 'string' ? data.stdout : '',
    stderr: typeof data.stderr === 'string' ? data.stderr : '',
    exitCode: typeof data.exit_code === 'number' ? data.exit_code : null,
    timedOut: data.timed_out === true,
  };
}

/**
 * Persists one transcript line to `voice_call_turns` — the mirror of the old
 * in-process `appendTurn()`. Fire-and-forget on purpose: a slow or failed
 * transcript write must never delay or interrupt the live conversation,
 * which is why callers do not `await` this (see transcripts.ts).
 */
export async function postTranscriptTurn(
  ctx: CallContext,
  role: 'user' | 'agent',
  text: string,
  speaker?: string | null,
): Promise<void> {
  const clean = text.trim();
  if (!clean) return;
  const result = await postJson(
    ctx,
    'turns',
    { call_id: ctx.callId, role, text: clean, speaker: speaker ?? null },
    TURN_TIMEOUT_MS,
  );
  if (!result.ok) {
    console.error('[voice-agent] transcript write failed', {
      callId: ctx.callId,
      role,
      error: result.error,
    });
  }
}
